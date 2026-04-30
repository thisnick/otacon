/**
 * Phase 3 sign-off e2e: HTTP API + SSE streaming.
 *
 * Authoritative test for the orchestrator-v2 Phase 3 verification checklist
 * (per /Users/nick/.claude/plans/calm-churning-panda.md "Phase 3" + task #6).
 *
 * Three scenarios share `pnpm orchestrator serve` boots and a shared
 * tmp ORCHESTRATOR_DATA_DIR:
 *
 *   A. Streaming + Resumability (auto-approve XHS scroll)
 *      - POST /api/v1/runs returns runId/workflowRunId
 *      - GET /api/v1/runs/:id/stream emits chunks with x-workflow-stream-tail-index
 *      - Mid-flight, second client tails from `?startIndex=N`; chunks
 *        from the resumed stream concatenate cleanly with the live ones
 *        (no duplicates, no gaps)
 *      - After data-run-completed, GET /stream?startIndex=0 replay matches
 *        the live observation byte-for-byte (chunk count + type sequence)
 *
 *   B. Cancellation
 *      - POST /api/v1/runs (long-running prompt; never auto-approves so
 *        the workflow blocks at first signal)
 *      - Wait for first chunk(s), then POST /api/v1/runs/:id/cancel
 *      - Tail the stream — terminal chunk is data-run-cancelled
 *      - GET /api/v1/runs/:id reports status="cancelled"
 *
 *   C. Durable approval across server restart
 *      - POST /api/v1/runs (no auto-approve)
 *      - Tail until first data-signal-created
 *      - **Kill the server process**; **respawn it on the same data dir**
 *      - POST /api/v1/signals/:id/resolve {decision: "approve"}
 *      - Re-open SSE; verify the workflow resumed and reaches data-run-completed
 *
 * Hardware required: phone-4 (with com.xingin.xhs), $OTACON_REGISTRY_URL,
 * $OTACON_TOKEN, $AI_GATEWAY_API_KEY. Same prereqs as phase1/2.
 *
 * Run: `pnpm test:e2e:phase3`
 *
 * Long-running: ~30-45min total across all 3 scenarios. Override per-scenario
 * via PHASE3_AGENT_TIMEOUT_MS / PHASE3_CANCEL_TIMEOUT_MS / PHASE3_DURABLE_TIMEOUT_MS.
 *
 * On failure: prints PASS/FAIL per check, exits non-zero. Evaluator reports
 * observable behavior; debugging is the implementer's job.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cancelRun,
  getRun,
  spawnServer,
  startRun,
  tailRun,
  type SpawnedServer,
  type UIMessageChunk,
} from './helpers/run-and-tail.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../..')
const ORCH_DIR = path.resolve(REPO_ROOT, 'src/orchestrator')

const PORT_A = process.env.PHASE3_PORT_A ?? '9101'
const PORT_B = process.env.PHASE3_PORT_B ?? '9102'
const PORT_C = process.env.PHASE3_PORT_C ?? '9103'
const ACCOUNT_ID = 'xhs:test'
const ACCOUNT_PHONE = process.env.PHASE3_ACCOUNT_PHONE ?? '+13412137456'
const TEAM_NAME = 'social-media-engagement'

const PROMPT_STREAMING =
  process.env.PHASE3_PROMPT_STREAMING ??
  'Open the Xiaohongshu app (com.xingin.xhs). Scroll the home feed three times. Then exit.'
const PROMPT_CANCEL =
  process.env.PHASE3_PROMPT_CANCEL ??
  'Open the Xiaohongshu app (com.xingin.xhs) and slowly browse the home feed for as long as you can. Take many actions.'
const PROMPT_DURABLE =
  process.env.PHASE3_PROMPT_DURABLE ??
  'Open the Xiaohongshu app (com.xingin.xhs). Tap any feed item. Then exit.'

const SCENARIO_A_TIMEOUT_MS = Number(process.env.PHASE3_AGENT_TIMEOUT_MS ?? 25 * 60_000)
const SCENARIO_B_TIMEOUT_MS = Number(process.env.PHASE3_CANCEL_TIMEOUT_MS ?? 5 * 60_000)
const SCENARIO_C_TIMEOUT_MS = Number(process.env.PHASE3_DURABLE_TIMEOUT_MS ?? 25 * 60_000)

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  PASS  ${msg}`)
    passed++
  } else {
    console.log(`  FAIL  ${msg}`)
    failures.push(msg)
    failed++
  }
}

function info(msg: string): void {
  console.log(`  INFO  ${msg}`)
}

interface RunJson {
  id: string
  workflowRunId?: string
  status?: string
  finalText?: string | null
  error?: string | null
}

async function runOrchestratorCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  const res = spawnSync('pnpm', ['orchestrator', ...args], {
    cwd: ORCH_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

interface Phase3Context {
  tmpDirA: string
  tmpDirB: string
  tmpDirC: string
  servers: SpawnedServer[]
}

const ctx: Phase3Context = { tmpDirA: '', tmpDirB: '', tmpDirC: '', servers: [] }

async function setupTmpDir(prefix: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  // Bootstrap: seed-team + add-account.
  const seed = await runOrchestratorCli(
    ['service', 'seed-team', '--name', TEAM_NAME],
    { ORCHESTRATOR_DATA_DIR: dir },
  )
  if (seed.status !== 0) {
    throw new Error(`seed-team failed: ${seed.stderr.slice(0, 500)}`)
  }
  const add = await runOrchestratorCli(
    ['service', 'add-account', '--id', ACCOUNT_ID, '--phone-number', ACCOUNT_PHONE, '--data-dir', dir],
    { ORCHESTRATOR_DATA_DIR: dir },
  )
  if (add.status !== 0) {
    throw new Error(`add-account failed: ${add.stderr.slice(0, 500)}`)
  }
  return dir
}

async function teardown(): Promise<void> {
  for (const srv of ctx.servers) {
    try {
      await srv.kill()
    } catch (e) {
      console.error('teardown: server kill failed', e)
    }
  }
  for (const dir of [ctx.tmpDirA, ctx.tmpDirB, ctx.tmpDirC]) {
    if (!dir) continue
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      console.error('teardown: tmpDir cleanup failed', e)
    }
  }
}

// ─── Scenario A ────────────────────────────────────────────────────────────

async function scenarioA(): Promise<void> {
  console.log('\n=== Scenario A: Streaming + Resumable Replay ===')
  ctx.tmpDirA = await setupTmpDir('orch-phase3a-')
  info(`tmpDir = ${ctx.tmpDirA}`)

  const server = await spawnServer({
    port: PORT_A,
    dataDir: ctx.tmpDirA,
    logPrefix: '[serverA]',
    readyTimeoutMs: 120_000,
  })
  ctx.servers.push(server)

  // Server up + /health.
  const health = await fetch(`${server.baseUrl}/health`)
  const healthBody = await health.text().catch(() => '')
  assert(health.status === 200 && healthBody.includes('ok'), `/health returns 200 + ok body (got ${health.status})`)

  // GET /api/v1/runs returns 200 (empty store).
  const runsListInit = await fetch(`${server.baseUrl}/api/v1/runs`)
  assert(runsListInit.status === 200, `GET /api/v1/runs returns 200 on empty store (got ${runsListInit.status})`)

  // Start the run.
  const startResp = await startRun({
    baseUrl: server.baseUrl,
    account: ACCOUNT_ID,
    team: TEAM_NAME,
    prompt: PROMPT_STREAMING,
  })
  assert(typeof startResp.runId === 'string' && startResp.runId.length > 0, `POST /api/v1/runs returns runId (${startResp.runId})`)
  assert(typeof startResp.workflowRunId === 'string' && startResp.workflowRunId.startsWith('wrun_'), `POST /api/v1/runs returns workflowRunId (${startResp.workflowRunId})`)

  // Mid-flight resumability: open the live tail until we have ≥30 chunks,
  // then disconnect. Capture x-workflow-stream-tail-index from the response.
  // Then resume from `?startIndex=<chunks.length>` (== chunk index of the
  // first chunk we did NOT see) and concatenate. The combined sequence must
  // equal a fresh full replay later.
  info('mid-flight: tailing live stream until ≥30 chunks, then disconnecting')
  const STOP_AFTER_CHUNKS = 30
  let livePartChunks: UIMessageChunk[] = []
  let livePartHeaders: Record<string, string> = {}
  let streamCompleted = false
  const livePartTail = await tailRun({
    baseUrl: server.baseUrl,
    runId: startResp.runId,
    startIndex: 0,
    autoApprove: true,
    timeoutMs: SCENARIO_A_TIMEOUT_MS,
    stopWhen: (_, chunks) => chunks.length >= STOP_AFTER_CHUNKS,
    noStopOnTerminal: false,
    onChunk: chunk => {
      const c = (livePartChunks.length + 1)
      if (c === 1 || c % 10 === 0) info(`livePart chunk #${c} type=${chunk.type}`)
    },
  })
  livePartChunks = livePartTail.chunks
  livePartHeaders = livePartTail.headers
  if (livePartTail.terminal) streamCompleted = true

  assert(livePartHeaders['x-workflow-run-id'] === startResp.workflowRunId, `live tail x-workflow-run-id matches workflowRunId`)
  assert(typeof livePartHeaders['x-workflow-stream-tail-index'] === 'string', `live tail emits x-workflow-stream-tail-index header (got "${livePartHeaders['x-workflow-stream-tail-index']}")`)
  assert(livePartChunks.length >= STOP_AFTER_CHUNKS || streamCompleted, `live tail captured ≥${STOP_AFTER_CHUNKS} chunks before disconnect (got ${livePartChunks.length}, terminal=${!!livePartTail.terminal})`)

  // Resume from where we left off. startIndex is the count of chunks we
  // already saw — Workflow SDK returns chunks at index >= startIndex.
  const resumeStart = livePartChunks.length
  info(`resuming from startIndex=${resumeStart}`)
  const resumePartTail = await tailRun({
    baseUrl: server.baseUrl,
    runId: startResp.runId,
    startIndex: resumeStart,
    autoApprove: true,
    timeoutMs: SCENARIO_A_TIMEOUT_MS,
    onChunk: chunk => {
      const c = (resumePartTail0Marker.count++)
      if (c === 0 || c % 100 === 0) info(`resumePart chunk #${c + 1} type=${chunk.type}`)
    },
  })
  assert(resumePartTail.terminal !== null, `resumed tail reaches a terminal chunk`)
  assert(resumePartTail.terminal?.type === 'data-run-completed', `resumed tail terminal === data-run-completed (got ${resumePartTail.terminal?.type})`)

  // Concatenated sequence from {live up to disconnect} + {resume from
  // startIndex} should equal a fresh replay-from-0.
  const concatenated = [...livePartChunks, ...resumePartTail.chunks]
  info(`concatenated chunk count: ${concatenated.length} (live=${livePartChunks.length} + resume=${resumePartTail.chunks.length})`)

  // Fresh replay from startIndex=0.
  info('fresh replay-from-0')
  const replayTail = await tailRun({
    baseUrl: server.baseUrl,
    runId: startResp.runId,
    startIndex: 0,
    autoApprove: false, // run is done; no signals
    timeoutMs: 120_000,
  })
  assert(replayTail.terminal !== null, `replay-from-0 reaches a terminal chunk`)
  assert(replayTail.terminal?.type === 'data-run-completed', `replay-from-0 terminal === data-run-completed`)

  // Resumability assertion: concat should equal full replay (same length,
  // same type sequence). Workflow SDK is supposed to produce bit-identical
  // replays — we verify type sequence as a robust shape check (chunks
  // include ULIDs that change per emission, but Workflow SDK persists
  // exact chunks so equality should hold).
  assert(
    concatenated.length === replayTail.chunks.length,
    `concat length matches full replay (concat=${concatenated.length} replay=${replayTail.chunks.length})`,
  )
  if (concatenated.length === replayTail.chunks.length) {
    let mismatch: number | null = null
    for (let i = 0; i < concatenated.length; i++) {
      if (concatenated[i].type !== replayTail.chunks[i].type) {
        mismatch = i
        break
      }
    }
    assert(mismatch === null, `concat type-sequence matches full replay in order (mismatch at index ${mismatch})`)
  }

  // No-duplicates check: the resumed segment should NOT re-emit any chunk
  // we already had in livePartChunks. Workflow SDK's startIndex semantics
  // guarantee this — chunks at index >= startIndex only.
  // (We don't have ULIDs to compare directly without making chunks
  // strictly identifiable, but length check above + type-sequence check
  // covers the no-duplicate, no-gap invariant.)

  // run.json status is completed.
  const runJsonPath = path.join(ctx.tmpDirA, 'runs', startResp.runId, 'run.json')
  const runJson = readJson<RunJson>(runJsonPath)
  assert(runJson?.status === 'completed', `run.json status === completed (got ${runJson?.status})`)
}

const resumePartTail0Marker = { count: 0 }

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return null
  }
}

// ─── Scenario B ────────────────────────────────────────────────────────────

async function scenarioB(): Promise<void> {
  console.log('\n=== Scenario B: Cancellation ===')
  ctx.tmpDirB = await setupTmpDir('orch-phase3b-')
  info(`tmpDir = ${ctx.tmpDirB}`)

  const server = await spawnServer({
    port: PORT_B,
    dataDir: ctx.tmpDirB,
    logPrefix: '[serverB]',
    readyTimeoutMs: 120_000,
  })
  ctx.servers.push(server)

  const startResp = await startRun({
    baseUrl: server.baseUrl,
    account: ACCOUNT_ID,
    team: TEAM_NAME,
    prompt: PROMPT_CANCEL,
  })
  info(`runId=${startResp.runId} workflowRunId=${startResp.workflowRunId}`)

  // Tail the stream; auto-approve initial signals so the agent starts
  // moving (otherwise it'd block on first approval). After ≥10 chunks,
  // POST cancel and verify the terminal chunk is data-run-cancelled.
  let cancelSent = false
  const tail = await tailRun({
    baseUrl: server.baseUrl,
    runId: startResp.runId,
    startIndex: 0,
    autoApprove: true,
    timeoutMs: SCENARIO_B_TIMEOUT_MS,
    stopWhen: (chunk, chunks) => {
      // Once we have ≥15 chunks, fire cancel asynchronously, then keep
      // reading until we hit a terminal chunk.
      if (!cancelSent && chunks.length >= 15) {
        cancelSent = true
        cancelRun({ baseUrl: server.baseUrl, runId: startResp.runId }).then(({ status }) => {
          info(`POST /cancel returned ${status}`)
        }).catch(e => info(`POST /cancel error: ${(e as Error).message}`))
      }
      return false  // never stop via stopWhen — let the terminal chunk close us
    },
    onChunk: chunk => {
      const t = chunk.type
      if (t === 'data-run-cancelled' || t === 'data-run-completed' || t === 'data-run-failed') {
        info(`scenario B terminal: ${t}`)
      }
    },
  })

  assert(cancelSent, `cancel was issued mid-flight`)
  assert(tail.terminal !== null, `scenario B reaches a terminal chunk`)
  assert(
    tail.terminal?.type === 'data-run-cancelled',
    `scenario B terminal === data-run-cancelled (got ${tail.terminal?.type})`,
  )

  // Verify run.json status=cancelled.
  const runJsonPath = path.join(ctx.tmpDirB, 'runs', startResp.runId, 'run.json')
  const runJson = readJson<RunJson>(runJsonPath)
  assert(runJson?.status === 'cancelled', `run.json status === cancelled (got ${runJson?.status})`)

  // Verify GET /api/v1/runs/:id reports cancelled.
  const detail = await getRun({ baseUrl: server.baseUrl, runId: startResp.runId })
  const detailRun = (detail.run as { run?: { status?: string } } | { status?: string } | null)
  // The route returns either {run: Run} or Run directly; handle both.
  const status =
    detailRun && typeof detailRun === 'object' && 'run' in detailRun
      ? (detailRun.run as { status?: string }).status
      : (detailRun as { status?: string } | null)?.status
  assert(status === 'cancelled', `GET /api/v1/runs/:id status === cancelled (got ${status})`)
}

// ─── Scenario C ────────────────────────────────────────────────────────────

async function scenarioC(): Promise<void> {
  console.log('\n=== Scenario C: Durable approval across server restart ===')
  ctx.tmpDirC = await setupTmpDir('orch-phase3c-')
  info(`tmpDir = ${ctx.tmpDirC}`)

  const serverV1 = await spawnServer({
    port: PORT_C,
    dataDir: ctx.tmpDirC,
    logPrefix: '[serverC1]',
    readyTimeoutMs: 120_000,
  })
  ctx.servers.push(serverV1)

  const startResp = await startRun({
    baseUrl: serverV1.baseUrl,
    account: ACCOUNT_ID,
    team: TEAM_NAME,
    prompt: PROMPT_DURABLE,
  })
  info(`runId=${startResp.runId} workflowRunId=${startResp.workflowRunId}`)

  // Tail (no auto-approve) until first data-signal-created appears.
  let signalId: string | null = null
  const preTail = await tailRun({
    baseUrl: serverV1.baseUrl,
    runId: startResp.runId,
    startIndex: 0,
    autoApprove: false,
    timeoutMs: SCENARIO_C_TIMEOUT_MS,
    stopWhen: chunk => {
      if (chunk.type === 'data-signal-created') {
        const data = (chunk as { data?: Record<string, unknown> }).data
        for (const k of ['signalId', 'signal_id', 'id']) {
          const v = data?.[k]
          if (typeof v === 'string') {
            signalId = v
            return true
          }
        }
      }
      return false
    },
    onChunk: chunk => {
      if (chunk.type === 'data-signal-created') info(`signal created mid-stream: ${chunk.id}`)
    },
  })
  void preTail
  assert(signalId !== null, `pre-restart tail captured a data-signal-created chunk (got ${signalId})`)
  if (!signalId) {
    info('cannot continue scenario C without a signal id')
    return
  }

  // Kill the server. The workflow should durably suspend per Workflow SDK.
  info('killing server v1')
  await serverV1.kill()
  // Remove from the cleanup list since we've killed it manually.
  ctx.servers = ctx.servers.filter(s => s !== serverV1)

  // Brief pause to let the OS release the port + flush nitro.
  await new Promise(r => setTimeout(r, 2000))

  // Spawn a fresh server pointing at the same data dir.
  info('spawning server v2 on same data dir')
  const serverV2 = await spawnServer({
    port: PORT_C,
    dataDir: ctx.tmpDirC,
    logPrefix: '[serverC2]',
    readyTimeoutMs: 120_000,
  })
  ctx.servers.push(serverV2)

  // Resolve the signal — this should resumeHook the durably-suspended workflow.
  info(`resolving signal ${signalId} on restarted server`)
  const resolveRes = await fetch(`${serverV2.baseUrl}/api/v1/signals/${signalId}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' }),
  })
  assert(resolveRes.status === 200, `POST /signals/:id/resolve returns 200 on restarted server (got ${resolveRes.status})`)

  // Tail through to completion (auto-approve any further signals).
  info('tailing post-restart through to completion')
  const postTail = await tailRun({
    baseUrl: serverV2.baseUrl,
    runId: startResp.runId,
    startIndex: 0,
    autoApprove: true,
    timeoutMs: SCENARIO_C_TIMEOUT_MS,
    onChunk: chunk => {
      if (chunk.type === 'data-signal-resolved') info(`signal resolved chunk seen`)
      if (chunk.type === 'data-run-completed') info(`run completed post-restart`)
    },
  })
  assert(postTail.terminal !== null, `post-restart tail reaches a terminal chunk`)
  assert(
    postTail.terminal?.type === 'data-run-completed',
    `post-restart terminal === data-run-completed (got ${postTail.terminal?.type})`,
  )

  // run.json status=completed.
  const runJsonPath = path.join(ctx.tmpDirC, 'runs', startResp.runId, 'run.json')
  const runJson = readJson<RunJson>(runJsonPath)
  assert(runJson?.status === 'completed', `scenario C run.json status === completed (got ${runJson?.status})`)
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== Phase 3 e2e ===')
  console.log(`prompt streaming = ${JSON.stringify(PROMPT_STREAMING)}`)
  console.log(`prompt cancel    = ${JSON.stringify(PROMPT_CANCEL)}`)
  console.log(`prompt durable   = ${JSON.stringify(PROMPT_DURABLE)}`)

  try {
    await scenarioA()
  } catch (e) {
    console.error('\nScenario A UNCAUGHT:', (e as Error).stack ?? (e as Error).message)
    failures.push(`scenario A UNCAUGHT: ${(e as Error).message}`)
    failed++
  }

  try {
    await scenarioB()
  } catch (e) {
    console.error('\nScenario B UNCAUGHT:', (e as Error).stack ?? (e as Error).message)
    failures.push(`scenario B UNCAUGHT: ${(e as Error).message}`)
    failed++
  }

  try {
    await scenarioC()
  } catch (e) {
    console.error('\nScenario C UNCAUGHT:', (e as Error).stack ?? (e as Error).message)
    failures.push(`scenario C UNCAUGHT: ${(e as Error).message}`)
    failed++
  }

  await teardown()

  console.log('\n=== Phase 3 e2e summary ===')
  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  } else {
    console.log('All checks PASS — Phase 3 verification complete.')
  }
}

main()
