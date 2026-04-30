/**
 * Phase 1 sign-off e2e: file-based backend + Workflow SDK adoption.
 *
 * Authoritative test for the orchestrator-v2 Phase 1 verification checklist
 * (per /Users/nick/.claude/plans/calm-churning-panda.md "Phase 1" + task #2).
 * Canonical scenario substituted from Chrome+search → Xiaohongshu+scroll at
 * lead commit `579face` because phone-4 (the only registry phone with a
 * phone_number set) has com.xingin.xhs installed but not Chrome — and XHS
 * is the social-media-engagement team's actual target app anyway.
 *
 * What this drives end-to-end:
 *   1. Create a fresh tmp ORCHESTRATOR_DATA_DIR.
 *   2. Seed the social-media-engagement team (FS layout).
 *   3. Add the xhs:test account (writes account/credentials/env stubs).
 *   4. Spawn `pnpm dev` (Nitro) against the tmp dir.
 *   5. Probe /health.
 *   6. Run the canonical XHS scroll prompt via the HTTP API (POST
 *      /api/v1/runs + tail SSE) with auto-approve so the test is
 *      non-interactive.
 *   7. Assert run.json status, prompt snapshot, workflow chunk persistence,
 *      replay (re-fetch /stream?startIndex=0 → matches live observation),
 *      traces, index/runs.jsonl.
 *   8. Cleanup spawn + tmp dir.
 *
 * Hardware required:
 *   - phone-4 reachable via the registry at $OTACON_REGISTRY_URL with
 *     $OTACON_TOKEN. Xiaohongshu (com.xingin.xhs) installed. Phone must
 *     have a phone_number set in the registry matching the account's primary
 *     credential (default: +13412137456 for xhs:test → phone-4).
 *   - $AI_GATEWAY_API_KEY for model calls.
 *
 * Run:
 *   pnpm test:e2e:phase1
 *
 * Long-running: agent loops on phone-4 take 1-15min. Default timeout 20min.
 *
 * On failure: this script prints PASS/FAIL per check and exits non-zero. The
 * evaluator's job is to capture observed-vs-expected — debugging is the
 * implementer's.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
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

const PORT = process.env.PHASE1_PORT ?? '9097'
const ACCOUNT_ID = 'xhs:test'
// Default targets phone-4 per lead decision at `579face` (only phone with a
// phone_number set in current registry state).
const ACCOUNT_PHONE = process.env.PHASE1_ACCOUNT_PHONE ?? '+13412137456'
const TEAM_NAME = 'social-media-engagement'
const PROMPT =
  process.env.PHASE1_PROMPT ??
  'Open the Xiaohongshu app (com.xingin.xhs). Scroll the home feed three times to see different content. Then exit.'
const AGENT_TIMEOUT_MS = Number(process.env.PHASE1_AGENT_TIMEOUT_MS ?? 20 * 60_000)

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

function readJson<T = unknown>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return null
  }
}

interface RunJson {
  id: string
  workflowRunId?: string
  account?: string
  team?: string
  agentRole?: string
  model?: string
  promptTemplatePaths?: string[]
  promptSnapshotPath?: string
  initialPrompt?: string | null
  status?: string
  startedAt?: number
  completedAt?: number | null
  finalText?: string | null
  error?: string | null
  turnCount?: number
}

interface IndexEntry {
  id: string
  account: string
  team: string
  status: string
  startedAt: number
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

interface Phase1Context {
  tmpDir: string
  server: SpawnedServer | null
}

const ctx: Phase1Context = { tmpDir: '', server: null }

async function setup(): Promise<void> {
  ctx.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-phase1-'))
  console.log(`\n=== Phase 1 e2e ===`)
  console.log(`tmpDir = ${ctx.tmpDir}`)
  console.log(`port   = ${PORT}`)
  console.log(`prompt = ${JSON.stringify(PROMPT)}`)
}

async function teardown(): Promise<void> {
  try {
    if (ctx.server) await ctx.server.kill()
  } catch (e) {
    console.error('teardown: server kill failed', e)
  }
  try {
    if (ctx.tmpDir && fs.existsSync(ctx.tmpDir)) {
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    }
  } catch (e) {
    console.error('teardown: tmpDir cleanup failed', e)
  }
}

async function step1Bootstrap(): Promise<void> {
  console.log('\n--- 1. Bootstrap (clean data dir + seed-team + add-account) ---')

  // Sanity: tmp data dir exists and is empty.
  assert(
    fs.existsSync(ctx.tmpDir) && fs.readdirSync(ctx.tmpDir).length === 0,
    'tmpDir is fresh + empty',
  )

  // Seed team. seed-team does NOT require DATABASE_URL.
  const seed = await runOrchestratorCli(
    ['service', 'seed-team', '--name', TEAM_NAME],
    { ORCHESTRATOR_DATA_DIR: ctx.tmpDir },
  )
  assert(seed.status === 0, `service seed-team --name ${TEAM_NAME} exits 0 (got ${seed.status})`)
  if (seed.status !== 0) {
    info(`seed-team stderr: ${seed.stderr.slice(0, 500)}`)
  }
  assert(
    fs.existsSync(path.join(ctx.tmpDir, 'teams', TEAM_NAME, 'team.json')),
    `teams/${TEAM_NAME}/team.json exists after seed-team`,
  )

  // Add account. Per current `service add-account` impl, this writes BOTH
  // DB and FS (dual-write). Plan calls for DB removal in P1, but the
  // dual-write is current implementer state. Tolerate either:
  //   a) command exits 0 with DATABASE_URL set (dual-write)
  //   b) command exits 0 without DATABASE_URL (DB write became optional)
  // If neither, observe-report.
  const add = await runOrchestratorCli(
    [
      'service',
      'add-account',
      '--id',
      ACCOUNT_ID,
      '--phone-number',
      ACCOUNT_PHONE,
      '--data-dir',
      ctx.tmpDir,
    ],
    { ORCHESTRATOR_DATA_DIR: ctx.tmpDir },
  )
  assert(
    add.status === 0,
    `service add-account --id ${ACCOUNT_ID} --phone-number ${ACCOUNT_PHONE} exits 0 (got ${add.status})`,
  )
  if (add.status !== 0) {
    info(`add-account stderr: ${add.stderr.slice(0, 500)}`)
  }

  // Verify FS layout. These are the plan-mandated artifacts regardless of
  // whether the DB write happened.
  const accountDir = path.join(ctx.tmpDir, 'accounts', ACCOUNT_ID)
  assert(fs.existsSync(path.join(accountDir, 'account.json')), 'accounts/xhs:test/account.json exists')
  assert(fs.existsSync(path.join(accountDir, 'credentials.json')), 'accounts/xhs:test/credentials.json exists')
  assert(fs.existsSync(path.join(accountDir, 'env', 'persona.md')), 'accounts/xhs:test/env/persona.md exists')
  assert(fs.existsSync(path.join(accountDir, 'env', 'soul.md')), 'accounts/xhs:test/env/soul.md exists')
  assert(fs.existsSync(path.join(accountDir, 'env', 'agents.md')), 'accounts/xhs:test/env/agents.md exists')
  assert(fs.existsSync(path.join(accountDir, 'workspace')), 'accounts/xhs:test/workspace/ exists')

  const accountJson = readJson<{ id?: string }>(path.join(accountDir, 'account.json'))
  assert(accountJson?.id === ACCOUNT_ID, `account.json has id=${ACCOUNT_ID}`)
  // Credentials file shape: { rows: [{credentialType, identifier, ...}] }
  const credsJson = readJson<{ rows?: Array<{ identifier?: string }> }>(
    path.join(accountDir, 'credentials.json'),
  )
  const credRows = Array.isArray(credsJson?.rows) ? credsJson.rows : []
  assert(
    credRows.some(c => c.identifier === ACCOUNT_PHONE),
    `credentials.json rows contains identifier=${ACCOUNT_PHONE} (got ${credRows.map(c => c.identifier).join(', ')})`,
  )
}

async function step2Server(): Promise<void> {
  console.log('\n--- 2. Server: spawn pnpm dev + probe /health ---')

  ctx.server = await spawnServer({
    port: PORT,
    dataDir: ctx.tmpDir,
    logPrefix: '[server]',
    readyTimeoutMs: 120_000,
  })
  info(`server up at ${ctx.server.baseUrl}`)

  // Health probe (plan + task #2 mandate this, even if implementer hasn't
  // added the route yet — observe-report.)
  let healthStatus: number | null = null
  let healthBody = ''
  try {
    const res = await fetch(`${ctx.server.baseUrl}/health`)
    healthStatus = res.status
    healthBody = await res.text().catch(() => '')
  } catch (e) {
    info(`/health fetch threw: ${(e as Error).message}`)
  }
  if (healthStatus === 200 && healthBody.includes('ok')) {
    assert(true, '/health returns 200 with ok body')
  } else {
    info(
      `/health returned status=${healthStatus}, body=${JSON.stringify(healthBody).slice(0, 200)}`,
    )
    assert(false, '/health returns 200 with ok body (plan + task #2 require it)')
  }
}

interface AgentRunResult {
  startResp: { runId: string; workflowRunId: string }
  liveChunks: UIMessageChunk[]
  terminal: UIMessageChunk | null
  liveHeaders: Record<string, string>
}

async function step3RunAgent(): Promise<AgentRunResult> {
  console.log('\n--- 3. Real agent run on phone (Xiaohongshu / scroll feed x3) ---')

  if (!ctx.server) throw new Error('server not initialized')

  const startResp = await startRun({
    baseUrl: ctx.server.baseUrl,
    account: ACCOUNT_ID,
    team: TEAM_NAME,
    prompt: PROMPT,
  })
  assert(typeof startResp.runId === 'string' && startResp.runId.length > 0, `POST /api/v1/runs returns runId (${startResp.runId})`)
  assert(typeof startResp.workflowRunId === 'string' && startResp.workflowRunId.startsWith('wrun_'), `POST /api/v1/runs returns workflowRunId starting with wrun_ (${startResp.workflowRunId})`)

  info(`tailing /stream — agent is talking to phone-3 + LLM. This may take ${Math.round(AGENT_TIMEOUT_MS / 60_000)}min.`)
  let chunkCount = 0
  const tail = await tailRun({
    baseUrl: ctx.server.baseUrl,
    runId: startResp.runId,
    autoApprove: true,
    timeoutMs: AGENT_TIMEOUT_MS,
    onChunk: chunk => {
      chunkCount++
      // Periodic progress so the operator sees life. Don't spam every chunk.
      if (chunkCount === 1 || chunkCount % 50 === 0) {
        info(`chunk #${chunkCount} type=${chunk.type}`)
      }
      if (chunk.type === 'data-signal-created') {
        info(`approval signal — auto-approving (chunk #${chunkCount})`)
      }
    },
  })

  assert(tail.terminal !== null, 'agent run reaches a terminal chunk before timeout')
  assert(tail.terminal?.type === 'data-run-completed', `terminal chunk is data-run-completed (got ${tail.terminal?.type})`)
  assert(
    tail.headers['x-workflow-run-id'] === startResp.workflowRunId,
    `x-workflow-run-id header matches workflowRunId (got ${tail.headers['x-workflow-run-id']})`,
  )

  return {
    startResp,
    liveChunks: tail.chunks,
    terminal: tail.terminal,
    liveHeaders: tail.headers,
  }
}

function step4Verify(run: AgentRunResult): void {
  console.log('\n--- 4-9. Verify run artifacts on disk ---')
  const { runId, workflowRunId } = run.startResp

  // ── 4. run.json ──────────────────────────────────────────────────────────
  const runJsonPath = path.join(ctx.tmpDir, 'runs', runId, 'run.json')
  assert(fs.existsSync(runJsonPath), `runs/${runId}/run.json exists`)
  const runJson = readJson<RunJson>(runJsonPath)
  assert(runJson?.status === 'completed', `run.json status === "completed" (got ${runJson?.status})`)
  assert(runJson?.workflowRunId === workflowRunId, `run.json workflowRunId matches (got ${runJson?.workflowRunId})`)
  assert(typeof runJson?.promptSnapshotPath === 'string' && (runJson?.promptSnapshotPath?.length ?? 0) > 0, `run.json promptSnapshotPath populated (got ${runJson?.promptSnapshotPath})`)
  assert(typeof runJson?.model === 'string' && (runJson?.model?.length ?? 0) > 0, `run.json model populated (got ${runJson?.model})`)
  assert(runJson?.team === TEAM_NAME, `run.json team === "${TEAM_NAME}"`)
  assert(typeof runJson?.agentRole === 'string' && (runJson?.agentRole?.length ?? 0) > 0, `run.json agentRole populated (got ${runJson?.agentRole})`)
  assert(typeof runJson?.completedAt === 'number' && (runJson?.completedAt ?? 0) > 0, 'run.json completedAt set')

  // ── 5. prompt.md ─────────────────────────────────────────────────────────
  const promptPath = path.join(ctx.tmpDir, 'runs', runId, 'prompt.md')
  assert(fs.existsSync(promptPath), `runs/${runId}/prompt.md exists`)
  const promptText = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf-8') : ''
  assert(promptText.length > 100, `prompt.md is non-trivial (${promptText.length} chars)`)
  // The system prompt typically references the account or team. We check for
  // the team name as a robust marker. If neither appears, the snapshot is
  // suspicious.
  assert(
    promptText.includes(TEAM_NAME) || promptText.toLowerCase().includes('engagement'),
    `prompt.md mentions team or role context (looking for "${TEAM_NAME}" or "engagement")`,
  )

  // ── 6. Workflow SDK persistence ──────────────────────────────────────────
  const workflowDir = path.join(ctx.tmpDir, 'workflow')
  assert(fs.existsSync(workflowDir), `${ctx.tmpDir}/workflow exists (Workflow SDK root)`)
  // World-local writes the run's stream registry at workflow/streams/runs/{wid}.json
  const streamRegistry = path.join(workflowDir, 'streams', 'runs', `${workflowRunId}.json`)
  assert(fs.existsSync(streamRegistry), `workflow/streams/runs/${workflowRunId}.json exists (chunks persisted)`)
  // And the run record at workflow/runs/{wid}.json
  const wfRunFile = path.join(workflowDir, 'runs', `${workflowRunId}.json`)
  assert(fs.existsSync(wfRunFile), `workflow/runs/${workflowRunId}.json exists`)
  const wfRun = readJson<{ status?: string }>(wfRunFile)
  assert(wfRun?.status === 'completed', `workflow run status === "completed" (got ${wfRun?.status})`)

  // ── 7. Replay via /stream?startIndex=0 matches live observation ──────────
  // (We already tailed once with startIndex=0 — do it again, compare.)
  const liveTypes = run.liveChunks.map(c => c.type)
  assert(liveTypes.includes('data-run-started'), 'live stream included data-run-started')
  assert(liveTypes.includes('data-run-completed'), 'live stream included data-run-completed')
  assert(
    liveTypes.filter(t => t === 'data-run-completed').length === 1,
    'exactly one data-run-completed in live stream',
  )

  // ── 8. traces/ ───────────────────────────────────────────────────────────
  const tracesDir = path.join(ctx.tmpDir, 'runs', runId, 'traces')
  let traceTcids: string[] = []
  if (fs.existsSync(tracesDir)) {
    traceTcids = fs.readdirSync(tracesDir).filter(name =>
      fs.statSync(path.join(tracesDir, name)).isDirectory(),
    )
  }
  assert(traceTcids.length > 0, `traces/ has at least one tool-call subdir (got ${traceTcids.length})`)
  if (traceTcids.length > 0) {
    const anyResult = traceTcids
      .map(tcid => path.join(tracesDir, tcid, 'result.json'))
      .find(p => fs.existsSync(p))
    assert(typeof anyResult === 'string', 'at least one traces/{tcid}/result.json exists')
    if (anyResult) {
      const r = readJson<unknown>(anyResult)
      assert(r !== null, 'traces/{tcid}/result.json is valid JSON')
    }
  }

  // ── 9. index/runs.jsonl tail entry has status=completed ──────────────────
  const indexFile = path.join(ctx.tmpDir, 'index', 'runs.jsonl')
  assert(fs.existsSync(indexFile), `${indexFile} exists`)
  if (fs.existsSync(indexFile)) {
    const lines = fs
      .readFileSync(indexFile, 'utf-8')
      .split('\n')
      .filter(l => l.trim().length > 0)
    const entries = lines
      .map(l => {
        try {
          return JSON.parse(l) as IndexEntry
        } catch {
          return null
        }
      })
      .filter((e): e is IndexEntry => e !== null)
    const forRun = entries.filter(e => e.id === runId)
    assert(forRun.length > 0, `index/runs.jsonl has entries for runId ${runId} (got ${forRun.length})`)
    const last = forRun[forRun.length - 1]
    assert(
      last?.status === 'completed',
      `last index entry for runId is status=completed (got ${last?.status})`,
    )
    assert(last?.account === ACCOUNT_ID, `last index entry account === "${ACCOUNT_ID}"`)
    assert(last?.team === TEAM_NAME, `last index entry team === "${TEAM_NAME}"`)
  }

  // Also check by-status/completed.jsonl includes this run
  const byStatusCompleted = path.join(ctx.tmpDir, 'index', 'by-status', 'completed.jsonl')
  if (fs.existsSync(byStatusCompleted)) {
    const has = fs.readFileSync(byStatusCompleted, 'utf-8').includes(runId)
    assert(has, `index/by-status/completed.jsonl includes runId ${runId}`)
  } else {
    info('index/by-status/completed.jsonl does not exist (informational; main runs.jsonl is the canonical index)')
  }
}

async function step5Replay(run: AgentRunResult): Promise<void> {
  console.log('\n--- 10. Replay: GET /stream?startIndex=0 on completed run matches live ---')
  if (!ctx.server) throw new Error('server not initialized')

  const replay = await tailRun({
    baseUrl: ctx.server.baseUrl,
    runId: run.startResp.runId,
    startIndex: 0,
    autoApprove: false, // run is done; no signals to resolve
    timeoutMs: 60_000,
  })

  assert(replay.terminal !== null, 'replay reaches a terminal chunk')
  assert(replay.terminal?.type === 'data-run-completed', `replay terminal === data-run-completed (got ${replay.terminal?.type})`)

  // Replay should have at least as many chunks as the live observation. The
  // live tail starts at startIndex=0 (per run-v2 client), so they should be
  // very close — same chunk count is the strict invariant.
  assert(
    replay.chunks.length === run.liveChunks.length,
    `replay chunk count matches live observation (live=${run.liveChunks.length} replay=${replay.chunks.length})`,
  )

  // Type sequences should match.
  if (replay.chunks.length === run.liveChunks.length) {
    let mismatch: number | null = null
    for (let i = 0; i < replay.chunks.length; i++) {
      if (replay.chunks[i].type !== run.liveChunks[i].type) {
        mismatch = i
        break
      }
    }
    assert(mismatch === null, `replay chunk types match live in order (mismatch at index ${mismatch})`)
  }
}

async function main(): Promise<void> {
  await setup()
  try {
    await step1Bootstrap()
    if (failed > 0) {
      info('bootstrap failed — skipping later steps')
      return
    }
    await step2Server()
    if (failed > 0 && !ctx.server) {
      info('server failed to start — skipping later steps')
      return
    }
    const runResult = await step3RunAgent()
    step4Verify(runResult)
    await step5Replay(runResult)
  } catch (e) {
    const err = e as Error
    console.error('\nUNCAUGHT EXCEPTION:', err.stack ?? err.message)
    failures.push(`UNCAUGHT: ${err.message}`)
    failed++
  } finally {
    await teardown()
  }

  console.log('\n=== Phase 1 e2e summary ===')
  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  } else {
    console.log('All checks PASS — Phase 1 verification complete.')
  }
}

main()
