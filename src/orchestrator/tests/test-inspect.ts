/**
 * Tests for `pnpm orchestrator inspect …` subcommands.
 *
 * Most of these are pure DB queries and don't require a phone.
 * The full conversation→markdown report generation needs a conversation
 * with messages + traces in blob storage; we set that up in this test
 * by writing fixture rows + fixture blob files directly.
 *
 * Run: npx tsx tests/test-inspect.ts
 *
 * Requires:
 *   - DATABASE_URL in .env, schema migrated
 *   - The orchestrator CLI accepting `inspect <subcommand>` (Phase A.2 task #7,#8)
 */
import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { ulid } from 'ulid'
import { sql } from 'drizzle-orm'
import { createDb } from '../src/db/client.js'
import { conversations, activityLog } from '../src/db/schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ORCHESTRATOR_DIR = path.resolve(__dirname, '..')
const BLOBS_DIR = path.join(ORCHESTRATOR_DIR, '.orchestrator-data/blobs')

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set — check src/orchestrator/.env')
  process.exit(1)
}

const db = createDb(DATABASE_URL)

let passed = 0
let failed = 0
const cleanupConvIds: string[] = []
const cleanupBlobDirs: string[] = []

function assert(cond: boolean, msg: string) {
  if (cond) { console.log(`  PASS  ${msg}`); passed++ }
  else { console.log(`  FAIL  ${msg}`); failed++ }
}

function runOrch(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync('npx', ['tsx', 'src/index.ts', ...args], {
    cwd: ORCHESTRATOR_DIR,
    encoding: 'utf-8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    timeout: 60_000,
  })
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    exitCode: r.status ?? -1,
  }
}

async function makeFixtureConversation(opts: {
  withMessages?: boolean
  withTraces?: boolean
  accountId?: string
}): Promise<string> {
  const convId = ulid()
  const accountId = opts.accountId ?? 'xhs:test'
  const blobPath = `conversations/${convId}`

  await db.insert(conversations).values({
    id: convId,
    conversationKey: `account:${accountId}:agent:engagement-lead`,
    blobPath,
    status: 'active',
  })
  cleanupConvIds.push(convId)

  if (opts.withMessages) {
    const msgDir = path.join(BLOBS_DIR, blobPath, 'messages')
    fs.mkdirSync(msgDir, { recursive: true })
    cleanupBlobDirs.push(path.join(BLOBS_DIR, blobPath))
    fs.writeFileSync(
      path.join(msgDir, '00001.json'),
      JSON.stringify({ role: 'system', content: 'You are an XHS browsing agent.' }, null, 2),
    )
    fs.writeFileSync(
      path.join(msgDir, '00002.json'),
      JSON.stringify({ role: 'user', content: 'Take a snapshot.' }, null, 2),
    )
    fs.writeFileSync(
      path.join(msgDir, '00003.json'),
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will take a snapshot.' },
          { type: 'tool-call', toolCallId: 'tooluse_FIXTURE_ABC', toolName: 'bash', input: { command: 'otacon snapshot && otacon swipe 540 1200 540 600' } },
        ],
      }, null, 2),
    )
  }

  if (opts.withTraces) {
    const traceDir = path.join(BLOBS_DIR, blobPath, 'traces', 'tooluse_FIXTURE_ABC')
    fs.mkdirSync(traceDir, { recursive: true })
    // Fixture annotated PNG (1x1 transparent)
    const tinyPng = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000005000167b6c0140000000049454e44ae426082',
      'hex',
    )
    fs.writeFileSync(path.join(traceDir, '001-swipe.png'), tinyPng)
    fs.writeFileSync(
      path.join(traceDir, '001-swipe.json'),
      JSON.stringify({ verb: 'swipe', args: ['540', '1200', '540', '600'], ts: Date.now(), seq: 1 }),
    )
  }

  return convId
}

async function cleanup() {
  for (const id of cleanupConvIds) {
    await db.execute(sql`DELETE FROM activity_log WHERE conversation_id = ${id}`).catch(() => {})
    await db.execute(sql`DELETE FROM phone_allocations WHERE conversation_id = ${id}`).catch(() => {})
    await db.execute(sql`DELETE FROM conversations WHERE id = ${id}`).catch(() => {})
  }
  for (const d of cleanupBlobDirs) {
    fs.rmSync(d, { recursive: true, force: true })
  }
}

// ----- Tests -----

async function testInspectSchema() {
  console.log('\n--- inspect schema ---')
  const r = runOrch(['inspect', 'schema'])
  assert(r.exitCode === 0, `inspect schema exit 0 (stderr: ${r.stderr.trim()})`)
  const out = r.stdout.toLowerCase()
  // Expected to mention the core tables
  for (const t of ['accounts', 'conversations', 'agent_instances', 'phone_allocations', 'activity_log']) {
    assert(out.includes(t), `output mentions table "${t}"`)
  }
}

async function testInspectCommands() {
  console.log('\n--- inspect commands ---')
  const r = runOrch(['inspect', 'commands'])
  assert(r.exitCode === 0, `inspect commands exit 0 (stderr: ${r.stderr.trim()})`)
  // Expect both registries' verbs to be listed
  for (const verb of ['otacon', 'otacon-alloc', 'tap', 'swipe', 'provision', 'release']) {
    assert(r.stdout.includes(verb), `output mentions "${verb}"`)
  }
}

async function testInspectConversationsList() {
  console.log('\n--- inspect conversations ---')
  const accountId = `xhs:test-inspect-${ulid()}`
  await makeFixtureConversation({ accountId, withMessages: false })

  const r = runOrch(['inspect', 'conversations', '--account', accountId])
  assert(r.exitCode === 0, `inspect conversations exit 0 (stderr: ${r.stderr.trim()})`)
  assert(r.stdout.includes(accountId), `output mentions account ${accountId}`)
}

async function testInspectConversationReport() {
  console.log('\n--- inspect conversation <id> generates markdown report ---')
  const convId = await makeFixtureConversation({ withMessages: true, withTraces: true })

  const r = runOrch(['inspect', 'conversation', convId])
  assert(r.exitCode === 0, `inspect conversation exit 0 (stderr: ${r.stderr.trim()})`)

  // Look for the generated report file in blob storage.
  const reportDir = path.join(BLOBS_DIR, `conversations/${convId}/reports`)
  const reportExists = fs.existsSync(reportDir)
  assert(reportExists, `reports dir created at conversations/${convId}/reports`)

  if (reportExists) {
    const reports = fs.readdirSync(reportDir).filter(f => f.endsWith('.md'))
    assert(reports.length >= 1, `at least 1 markdown report (got ${reports.length})`)

    if (reports.length > 0) {
      const report = fs.readFileSync(path.join(reportDir, reports[0]), 'utf-8')
      assert(report.length > 100, `report has content (${report.length} chars)`)
      assert(report.includes(convId) || report.toLowerCase().includes('conversation'), 'report mentions conversation')
      assert(report.includes('snapshot') || report.includes('swipe'), 'report references tool calls')

      // Image references should resolve to actual files
      const imgMatches = [...report.matchAll(/!\[[^\]]*\]\(([^)]+\.png)\)/g)]
      assert(imgMatches.length > 0, `report embeds at least 1 PNG (got ${imgMatches.length})`)
      for (const m of imgMatches) {
        const imgRel = m[1]
        // Resolve relative to the report file
        const resolved = path.resolve(reportDir, imgRel)
        const exists = fs.existsSync(resolved)
        assert(exists, `image path resolves: ${imgRel} → ${resolved}`)
      }
    }
  }
}

async function testInspectState() {
  console.log('\n--- inspect state ---')
  // Seed some activity for an account
  const accountId = `xhs:test-state-${ulid()}`
  const convId = await makeFixtureConversation({ accountId, withMessages: false })
  await db.insert(activityLog).values({
    id: ulid(),
    conversationId: convId,
    sessionId: 'test-session',
    actionType: 'bash',
    target: 'otacon snapshot',
    details: {},
  })

  const r = runOrch(['inspect', 'state', '--account', accountId])
  assert(r.exitCode === 0, `inspect state exit 0 (stderr: ${r.stderr.trim()})`)
  assert(r.stdout.includes(accountId), `output mentions account`)
}

async function testInspectLogs() {
  console.log('\n--- inspect logs ---')
  const accountId = `xhs:test-logs-${ulid()}`
  const convId = await makeFixtureConversation({ accountId, withMessages: false })
  await db.insert(activityLog).values({
    id: ulid(),
    conversationId: convId,
    sessionId: 's1',
    actionType: 'bash',
    target: 'otacon snapshot',
    details: { result: 'ok' },
  })

  const r = runOrch(['inspect', 'logs', '--account', accountId])
  assert(r.exitCode === 0, `inspect logs exit 0 (stderr: ${r.stderr.trim()})`)
  assert(
    r.stdout.includes('otacon snapshot') || r.stdout.includes('bash'),
    `logs include the activity (stdout: ${r.stdout.trim().slice(0, 200)}…)`,
  )
}

async function main() {
  console.log('=== Inspect Command Tests ===')
  try {
    await testInspectSchema()
    await testInspectCommands()
    await testInspectConversationsList()
    await testInspectConversationReport()
    await testInspectState()
    await testInspectLogs()
  } finally {
    await cleanup()
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  cleanup().finally(() => process.exit(1))
})
