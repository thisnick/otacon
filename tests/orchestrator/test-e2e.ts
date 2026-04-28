/**
 * End-to-end test for the orchestrator pipeline.
 * Starts the orchestrator as a subprocess, auto-approves actions,
 * and verifies: team loading, blob writes, conversation persistence,
 * durable sleep, and kill/resume.
 *
 * Requires:
 * - phone-4 (phone-11031jec) reachable
 * - DATABASE_URL set in .env
 * - AI gateway configured (GATEWAY_API_KEY)
 * - xhs:test account seeded in DB
 *
 * Run: npx tsx tests/orchestrator/test-e2e.ts
 */
import { spawn, execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ORCHESTRATOR_DIR = path.resolve(__dirname, '../../src/orchestrator')
const APPROVALS_DIR = path.join(ORCHESTRATOR_DIR, '.orchestrator/approvals')
const BLOBS_DIR = path.join(ORCHESTRATOR_DIR, '.orchestrator-data/blobs')
const AUTO_APPROVE_SCRIPT = path.resolve(__dirname, '../auto-approve.sh')

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  PASS  ${msg}`)
    passed++
  } else {
    console.log(`  FAIL  ${msg}`)
    failed++
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Run orchestrator, capture log, return when it exits or timeout. */
function startOrchestrator(prompt: string, logFile: string): { proc: ReturnType<typeof spawn>, done: Promise<number> } {
  const logFd = fs.openSync(logFile, 'w')
  const proc = spawn('npx', [
    'tsx', 'src/index.ts', 'run',
    '--account', 'xhs:test',
    '--team', 'social-media-engagement',
    '--prompt', prompt,
  ], {
    cwd: ORCHESTRATOR_DIR,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })

  const done = new Promise<number>((resolve) => {
    proc.on('exit', (code) => {
      fs.closeSync(logFd)
      resolve(code ?? 1)
    })
    // Safety timeout: kill after 90s
    setTimeout(() => {
      try { proc.kill() } catch {}
      resolve(-1)
    }, 90_000)
  })

  return { proc, done }
}

/** Start auto-approver as background process. */
function startAutoApprover(logFile: string): ReturnType<typeof spawn> {
  const logFd = fs.openSync(logFile, 'w')
  const proc = spawn('bash', [AUTO_APPROVE_SCRIPT, APPROVALS_DIR], {
    stdio: ['ignore', logFd, logFd],
  })
  proc.on('exit', () => { try { fs.closeSync(logFd) } catch {} })
  return proc
}

function readLog(logFile: string): string {
  try { return fs.readFileSync(logFile, 'utf-8') } catch { return '' }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

// ---- Tests ----

async function testTeamLoading() {
  console.log('\n--- E2E: team loading + conversation create ---')
  const logFile = '/tmp/e2e-test-1.log'
  const approverLog = '/tmp/e2e-test-1-approver.log'

  // Clean up old approvals
  fs.mkdirSync(APPROVALS_DIR, { recursive: true })

  const approver = startAutoApprover(approverLog)
  const { proc, done } = startOrchestrator(
    'Take a snapshot and briefly describe what you see',
    logFile,
  )

  const exitCode = await done
  approver.kill()

  const log = stripAnsi(readLog(logFile))

  assert(log.includes('[team] Loading team "social-media-engagement"'), 'team loaded')
  assert(log.includes('lead agent "engagement-lead"'), 'lead agent identified')
  assert(log.includes('Model: alibaba/qwen3.6-plus'), 'model configured')
  assert(log.includes('Account: xhs:test'), 'account loaded from DB')
  assert(log.includes('[team] Sandbox ready'), 'sandbox built')
  assert(log.includes('[agent] Turn 1'), 'agent started Turn 1')
  assert(log.includes('[agent] Conversation saved'), 'conversation saved')

  // Extract conversation ID
  const convoMatch = log.match(/(?:Created new conversation|Resuming conversation): (\S+)/)
  if (convoMatch) {
    console.log(`  (conversation ID: ${convoMatch[1]})`)
  }
}

async function testBlobWrites() {
  console.log('\n--- E2E: blob writes via sandbox ---')
  const logFile = '/tmp/e2e-test-2.log'
  const approverLog = '/tmp/e2e-test-2-approver.log'

  const approver = startAutoApprover(approverLog)
  const { proc, done } = startOrchestrator(
    'Take a snapshot, then write a brief summary of what you see to /workspace/e2e-test-output.md',
    logFile,
  )

  const exitCode = await done
  approver.kill()

  const log = stripAnsi(readLog(logFile))
  assert(log.includes('[agent] Conversation saved'), 'agent completed')

  // Check blob file was written
  const blobFile = path.join(BLOBS_DIR, 'accounts/xhs:test/workspace/e2e-test-output.md')
  const exists = fs.existsSync(blobFile)
  assert(exists, 'blob file written at workspace/e2e-test-output.md')

  if (exists) {
    const content = fs.readFileSync(blobFile, 'utf-8')
    assert(content.length > 10, `blob has content (${content.length} chars)`)
    // Clean up test file
    fs.rmSync(blobFile, { force: true })
  }
}

async function testConversationPersistence() {
  console.log('\n--- E2E: conversation persistence across runs ---')
  const logFile1 = '/tmp/e2e-test-3a.log'
  const logFile2 = '/tmp/e2e-test-3b.log'
  const approverLog = '/tmp/e2e-test-3-approver.log'

  // Run 1: should create or resume conversation
  const approver1 = startAutoApprover(approverLog)
  const { done: done1 } = startOrchestrator('Say hello', logFile1)
  await done1
  approver1.kill()

  const log1 = stripAnsi(readLog(logFile1))
  const convoMatch = log1.match(/(?:Created new conversation|Resuming conversation): (\S+)/)
  assert(convoMatch !== null, 'run 1 has conversation ID')
  const convoId = convoMatch?.[1]
  const msgMatch1 = log1.match(/Conversation saved \((\d+) messages\)/)
  const msgCount1 = msgMatch1 ? parseInt(msgMatch1[1]) : 0
  assert(msgCount1 > 0, `run 1 saved ${msgCount1} messages`)

  // Run 2: should RESUME the same conversation
  const approver2 = startAutoApprover(approverLog)
  const { done: done2 } = startOrchestrator('Say goodbye', logFile2)
  await done2
  approver2.kill()

  const log2 = stripAnsi(readLog(logFile2))
  assert(log2.includes(`Resuming conversation: ${convoId}`), 'run 2 resumes same conversation')
  const msgMatch2 = log2.match(/Conversation saved \((\d+) messages\)/)
  const msgCount2 = msgMatch2 ? parseInt(msgMatch2[1]) : 0
  assert(msgCount2 > msgCount1, `run 2 has more messages (${msgCount2} > ${msgCount1})`)
}

async function testDurableSleep() {
  console.log('\n--- E2E: durable sleep ---')
  const logFile = '/tmp/e2e-test-4.log'
  const approverLog = '/tmp/e2e-test-4-approver.log'

  const approver = startAutoApprover(approverLog)
  const { done } = startOrchestrator(
    'Sleep for 3 seconds, then take a snapshot',
    logFile,
  )

  const exitCode = await done
  approver.kill()

  const log = stripAnsi(readLog(logFile))
  assert(log.includes('[sleep]'), 'sleep tool was called')
  assert(log.includes('sleeping for 3s') || log.includes('3000ms'), 'sleep duration logged')
  assert(log.includes('[agent] Conversation saved'), 'agent completed after sleep')
}

async function testKillResume() {
  console.log('\n--- E2E: kill + resume ---')
  const logFile1 = '/tmp/e2e-test-5a.log'
  const logFile2 = '/tmp/e2e-test-5b.log'
  const approverLog = '/tmp/e2e-test-5-approver.log'

  // Start orchestrator with a prompt that will take a while
  const approver = startAutoApprover(approverLog)
  const { proc, done } = startOrchestrator(
    'Take a snapshot, scroll down, take another snapshot, scroll down again',
    logFile1,
  )

  // Wait for it to start producing output
  let waited = 0
  while (waited < 30000) {
    const log = readLog(logFile1)
    if (log.includes('[agent] Turn 1')) break
    await sleep(500)
    waited += 500
  }

  // Give it a bit more time to make progress
  await sleep(3000)

  // Check message count before kill
  const log1 = stripAnsi(readLog(logFile1))
  const convoMatch = log1.match(/(?:Created new conversation|Resuming conversation): (\S+)/)
  const convoId = convoMatch?.[1]
  assert(convoId !== undefined, `conversation ID found: ${convoId}`)

  // Kill it
  proc.kill('SIGTERM')
  await done

  // Check if conversation was saved or not (depends on timing)
  const convDir = convoId ? path.join(BLOBS_DIR, `conversations/${convoId}/messages`) : ''
  let msgCountBeforeKill = 0
  if (convDir && fs.existsSync(convDir)) {
    msgCountBeforeKill = fs.readdirSync(convDir).filter(f => f.endsWith('.json')).length
  }
  console.log(`  (messages on disk after kill: ${msgCountBeforeKill})`)

  // Resume
  const { done: done2 } = startOrchestrator('Take a snapshot', logFile2)
  await done2
  approver.kill()

  const log2 = stripAnsi(readLog(logFile2))
  if (convoId) {
    assert(log2.includes(`Resuming conversation: ${convoId}`), 'resumes same conversation after kill')
  }
  assert(log2.includes('[agent] Conversation saved'), 'agent completes after resume')

  const msgMatch2 = log2.match(/Conversation saved \((\d+) messages\)/)
  const msgCount2 = msgMatch2 ? parseInt(msgMatch2[1]) : 0
  assert(msgCount2 >= msgCountBeforeKill, `messages after resume (${msgCount2}) >= before kill (${msgCountBeforeKill})`)
}

async function testApprovalFlow() {
  console.log('\n--- E2E: approval flow ---')
  const logFile = '/tmp/e2e-test-6.log'
  const approverLog = '/tmp/e2e-test-6-approver.log'

  const approver = startAutoApprover(approverLog)
  const { done } = startOrchestrator(
    'Scroll down once on the current screen',
    logFile,
  )

  await done
  approver.kill()

  const log = stripAnsi(readLog(logFile))
  assert(log.includes('APPROVAL REQUIRED'), 'approval prompt shown')
  assert(log.includes('Signal ID:'), 'signal ID displayed')
  assert(log.includes('Command:'), 'command shown in approval')
  assert(log.includes('Rationale:'), 'rationale shown in approval')

  // Check auto-approver caught the signal
  const approverOutput = readLog(approverLog)
  assert(approverOutput.includes('Approving signal'), 'auto-approver approved signal')
}

async function main() {
  console.log('=== Orchestrator E2E Tests ===')
  console.log(`  orchestrator dir: ${ORCHESTRATOR_DIR}`)
  console.log(`  approvals dir: ${APPROVALS_DIR}`)

  // Wake phone first
  try {
    execSync('curl -sk -X POST https://otacon-pi.tail0437b8.ts.net:8080/phones/phone-11031jec/api/action -H "Content-Type: application/json" -d \'{"action":"key","key":"WAKEUP"}\'', { timeout: 10000 })
    execSync('curl -sk -X POST https://otacon-pi.tail0437b8.ts.net:8080/phones/phone-11031jec/api/action -H "Content-Type: application/json" -d \'{"action":"key","key":"MENU"}\'', { timeout: 10000 })
    console.log('  phone woken up')
  } catch {
    console.log('  WARNING: could not wake phone')
  }

  await testTeamLoading()
  await testBlobWrites()
  await testConversationPersistence()
  await testDurableSleep()
  await testApprovalFlow()
  await testKillResume()

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
