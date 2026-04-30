/**
 * Phase 6 sign-off e2e: Vite + React + WorkflowAgent web UI v2.
 *
 * Authoritative test for the orchestrator-v2 Phase 6 verification checklist
 * (per docs/orchestrator-v2-plan.md "Phase 6 — Web UI v2" + task #2).
 *
 * What this drives end-to-end (real Chromium via Playwright):
 *
 *   1. Static load + React app boot
 *      - Built bundle (vite build → static/dist/) served by Nitro at :9090
 *      - Runs-list page loads, no console errors, specifically:
 *          * NO "[DONE]" parse error
 *          * NO SSE error
 *          * NO React hydration error
 *          * NO chunk-type-mismatch warnings (v6 vs v7: tool-call/tool-result
 *            replaced by tool-input-{start,delta,available} + tool-output-available)
 *
 *   2. Live streaming via useChat
 *      - Kick off canonical XHS scroll scenario on phone-4
 *      - Browser updates live as chunks arrive (text accumulates in
 *        assistant-message, tool-call-card cards appear in real time)
 *      - Run reaches data-run-completed
 *
 *   3. Approval-from-UI via addToolApprovalResponse
 *      - --require-approval scenario (mutating action requires approval)
 *      - data-testid="approval-card" appears in the DOM (AI SDK UI Elements
 *        primitive, NOT old custom signal card)
 *      - Click data-testid="approval-approve"
 *      - Run resumes (next chunks arrive) and reaches data-run-completed
 *
 *   4. data-phone-action cards render
 *      - data-testid="phone-action-card" present after a phone action
 *      - 3 thumbnails: data-testid="phone-action-thumb-{before,annotated,after}"
 *      - Modal navigation works (click thumb → enlarged modal w/ prev/next)
 *
 *   5. Durability across server restart (CRITICAL)
 *      - Run paused at approval (mutating action with --require-approval)
 *      - Kill orchestrator process
 *      - Restart orchestrator on same data dir
 *      - Refresh browser tab → approval card still visible (RunStore.messages
 *        persisted; conversation-as-durable-store)
 *      - Click Approve → POST /messages with updated history → fresh workflow
 *        run continues → reaches data-run-completed
 *      - CRITICAL: proves the WorkflowAgent migration didn't lose durable
 *        suspension. Mechanism per task #1 locked decisions: under
 *        WorkflowAgent + needsApproval, when model emits tool-approval-request
 *        the workflow run terminates and state lives in conversation history.
 *        Observable behavior identical to P3 hook-suspension version.
 *
 *   6. CLI parity (NO --prompt flag — browser-only entry)
 *      - `pnpm orchestrator runs create --account xhs:test --team ...` exits 0
 *      - stdout matches https?://.* /runs/[A-Z0-9]+
 *      - GET on the printed URL returns 200 HTML with React root
 *      - GET /api/v1/runs/<id> returns 200 JSON with status created|running
 *
 *   7. Regressions (run as part of pnpm test:e2e:phase{1,2,3,5})
 *      - phase1, phase2, phase3, phase5 still green against P6 commits
 *      - Phase 4 was superseded by P6 (no regression run needed)
 *      - This script does NOT re-run them inline; the evaluator runs them
 *        separately and includes outputs in sign-off task update.
 *      - If chunk-type assertions in earlier phases fail because P6 changed
 *        shapes (v7 cascading renames), evaluator files observed-vs-expected;
 *        implementer fixes (do NOT investigate root cause).
 *
 * Hardware required:
 *   - phone-4 reachable via $OTACON_REGISTRY_URL with $OTACON_TOKEN
 *   - Xiaohongshu (com.xingin.xhs) installed on phone-4
 *   - Phone has phone_number set in registry matching xhs:test credential
 *     (default: +13412137456)
 *   - $AI_GATEWAY_API_KEY for model calls
 *   - Playwright Chromium browser installed (`pnpm exec playwright install chromium`)
 *
 * Run:
 *   pnpm test:e2e:phase6
 *
 * Long-running: ~30-50min total. Override per-scenario via PHASE6_*_TIMEOUT_MS.
 *
 * On failure: prints PASS/FAIL per check, exits non-zero. The evaluator
 * captures observed-vs-expected; debugging is the implementer's job
 * (see feedback_team_roles.md).
 *
 * ============================================================================
 * STATUS: SKELETON — assertions stubbed pending P6-I (task #1) handoff.
 * ============================================================================
 *
 * The scenarios below are stubbed with TODO markers. Each TODO references
 * which P6-E assertion (#1-#7) it covers. Selectors use the data-testid
 * contract locked in task #2 — implementer is committed to baking in:
 *   - runs-list-root, runs-list-row (with data-run-id={id})
 *   - new-run-button, new-run-modal, new-run-prompt-input,
 *     new-run-account-select, new-run-team-select, new-run-submit
 *   - assistant-message, tool-call-card, run-status, run-final-text
 *   - approval-card, approval-approve, approval-deny, approval-skip
 *   - phone-action-card, phone-action-thumb-{before,annotated,after}
 *
 * Routes (locked in task #1):
 *   - POST /api/v1/runs                                              (create run)
 *   - POST /api/v1/runs/:id/messages                                 (send message)
 *   - GET  /api/v1/runs/:id/messages/:workflowRunId/stream?startIndex=N (resume)
 *   - POST /api/v1/runs/:id/cancel                                   (cancel)
 *
 * If implementer ships without these testids OR without the routes locked,
 * file feedback via TaskUpdate observed-vs-expected; do NOT debug.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  spawnServer,
  startRun,
  type SpawnedServer,
  type UIMessageChunk,
} from './helpers/run-and-tail.js'

// Playwright is loaded lazily so the rest of the suite doesn't require
// Chromium binaries to be installed (we only need it for phase6).
// Install via: `pnpm --filter otacon-orchestrator exec playwright install chromium`
type PWBrowser = import('playwright').Browser
type PWPage = import('playwright').Page
type PWBrowserContext = import('playwright').BrowserContext

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../..')
const ORCH_DIR = path.resolve(REPO_ROOT, 'src/orchestrator')

const PORT = process.env.PHASE6_PORT ?? '9106'
const ACCOUNT_ID = 'xhs:test'
const ACCOUNT_PHONE = process.env.PHASE6_ACCOUNT_PHONE ?? '+13412137456'
const TEAM_NAME = 'social-media-engagement'

// Scenario-specific prompts. Each tuned for the assertion it backs.
const PROMPT_STATIC = '<not used — static-load scenario does not start a run>'
const PROMPT_STREAMING =
  process.env.PHASE6_PROMPT_STREAMING ??
  'Open the Xiaohongshu app (com.xingin.xhs). Scroll the home feed three times. Then exit.'
const PROMPT_APPROVAL =
  process.env.PHASE6_PROMPT_APPROVAL ??
  'Open the Xiaohongshu app (com.xingin.xhs). Tap any feed item. Then exit.'
const PROMPT_DURABLE =
  process.env.PHASE6_PROMPT_DURABLE ??
  'Open the Xiaohongshu app (com.xingin.xhs). Tap any feed item. Then exit.'

// Per-scenario timeouts. Streaming is a normal scroll; approval/durable
// scenarios suspend at the first mutating action.
const STATIC_TIMEOUT_MS = Number(process.env.PHASE6_STATIC_TIMEOUT_MS ?? 60_000)
const STREAMING_TIMEOUT_MS = Number(process.env.PHASE6_STREAMING_TIMEOUT_MS ?? 25 * 60_000)
const APPROVAL_TIMEOUT_MS = Number(process.env.PHASE6_APPROVAL_TIMEOUT_MS ?? 25 * 60_000)
const PHONE_ACTION_TIMEOUT_MS = Number(process.env.PHASE6_PHONE_ACTION_TIMEOUT_MS ?? 25 * 60_000)
const DURABLE_TIMEOUT_MS = Number(process.env.PHASE6_DURABLE_TIMEOUT_MS ?? 25 * 60_000)
const CLI_TIMEOUT_MS = Number(process.env.PHASE6_CLI_TIMEOUT_MS ?? 60_000)

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

function section(title: string): void {
  console.log(`\n--- ${title} ---`)
}

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

interface Phase6Context {
  tmpDir: string
  server: SpawnedServer | null
  browser: PWBrowser | null
  context: PWBrowserContext | null
  /** Console errors captured by Playwright across the run. */
  consoleErrors: string[]
  /** Network failures captured by Playwright. */
  networkFailures: string[]
}

const ctx: Phase6Context = {
  tmpDir: '',
  server: null,
  browser: null,
  context: null,
  consoleErrors: [],
  networkFailures: [],
}

async function setup(): Promise<void> {
  ctx.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-phase6-'))
  console.log(`\n=== Phase 6 e2e ===`)
  console.log(`tmpDir = ${ctx.tmpDir}`)
  console.log(`port   = ${PORT}`)
  console.log(`account= ${ACCOUNT_ID} (phone ${ACCOUNT_PHONE})`)
}

async function teardown(): Promise<void> {
  // Browser first so console captures finalize before server kill noise.
  try {
    if (ctx.context) await ctx.context.close()
  } catch (e) {
    console.error('teardown: browser context close failed', e)
  }
  try {
    if (ctx.browser) await ctx.browser.close()
  } catch (e) {
    console.error('teardown: browser close failed', e)
  }
  try {
    if (ctx.server) await ctx.server.kill()
  } catch (e) {
    console.error('teardown: server kill failed', e)
  }
  try {
    if (process.env.KEEP_TMP_DIR === '1') {
      console.log(`KEEP_TMP_DIR=1 — preserving ${ctx.tmpDir} for manual inspection`)
      return
    }
    if (ctx.tmpDir && fs.existsSync(ctx.tmpDir)) {
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    }
  } catch (e) {
    console.error('teardown: tmpDir cleanup failed', e)
  }
}

// ---------------------------------------------------------------------------
// Bootstrap (matches phase1: seed-team + add-account against tmp data dir)
// ---------------------------------------------------------------------------

async function runOrchestratorCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
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

async function bootstrap(): Promise<void> {
  section('0. Bootstrap (seed-team + add-account on tmp data dir)')

  const seed = await runOrchestratorCli(
    ['service', 'seed-team', '--name', TEAM_NAME],
    { ORCHESTRATOR_DATA_DIR: ctx.tmpDir },
  )
  assert(seed.status === 0, `service seed-team --name ${TEAM_NAME} exits 0 (got ${seed.status})`)
  if (seed.status !== 0) info(`seed-team stderr: ${seed.stderr.slice(0, 500)}`)

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
  assert(add.status === 0, `service add-account --id ${ACCOUNT_ID} exits 0 (got ${add.status})`)
  if (add.status !== 0) info(`add-account stderr: ${add.stderr.slice(0, 500)}`)
}

async function spawnOrch(env: NodeJS.ProcessEnv = {}): Promise<SpawnedServer> {
  // Production-parity: build the bundle then run Nitro. Plan + lead decision
  // (P6-E answers): test against built static/dist/ served by Nitro :9090,
  // NOT Vite dev server.
  // The build step is the implementer's responsibility — this test assumes
  // `pnpm --filter otacon-orchestrator build` has been run beforehand. If
  // the bundle is missing, scenario 1 (static load) will fail and the
  // evaluator surfaces that as observed-vs-expected.
  return spawnServer({
    port: PORT,
    dataDir: ctx.tmpDir,
    logPrefix: '[orch]',
    readyTimeoutMs: 120_000,
    env,
  })
}

// ---------------------------------------------------------------------------
// Browser setup — captures console errors + network failures globally so
// every assertion can check for "no React hydration error" etc.
// ---------------------------------------------------------------------------

async function launchBrowser(): Promise<{ browser: PWBrowser; context: PWBrowserContext }> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({
    headless: process.env.PHASE6_HEADLESS !== '0',
  })
  const context = await browser.newContext()

  context.on('weberror', err => {
    ctx.consoleErrors.push(`weberror: ${err.error().message}`)
  })

  return { browser, context }
}

async function newPage(): Promise<PWPage> {
  if (!ctx.context) throw new Error('browser context not initialized')
  const page = await ctx.context.newPage()
  page.on('console', msg => {
    if (msg.type() === 'error') {
      ctx.consoleErrors.push(`[${page.url()}] ${msg.text()}`)
    }
  })
  page.on('pageerror', err => {
    ctx.consoleErrors.push(`[${page.url()}] pageerror: ${err.message}`)
  })
  page.on('requestfailed', req => {
    ctx.networkFailures.push(`[${page.url()}] ${req.failure()?.errorText ?? 'failed'} ${req.url()}`)
  })
  return page
}

/**
 * Scan captured console errors for the specific failure modes called out in
 * the P6-E checklist. Returns matching error strings (empty array = clean).
 */
function findForbiddenErrors(errors: string[]): { kind: string; msg: string }[] {
  const forbidden: { kind: string; pattern: RegExp }[] = [
    { kind: 'DONE-parse', pattern: /\[DONE\].*JSON/i },
    { kind: 'SSE-error', pattern: /SSE.*error|EventSource.*error/i },
    { kind: 'React-hydration', pattern: /hydrat(ion|ed)/i },
    { kind: 'chunk-type-mismatch', pattern: /chunk type|tool-call.*tool-input|tool-result.*tool-output/i },
  ]
  const hits: { kind: string; msg: string }[] = []
  for (const err of errors) {
    for (const f of forbidden) {
      if (f.pattern.test(err)) {
        hits.push({ kind: f.kind, msg: err })
        break
      }
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// Scenario 1 — Static load + React app boot
// P6-E assertion #1: runs list renders, no console errors, no [DONE] parse
// error, no SSE error, no hydration error, no chunk-type-mismatch warnings.
// ---------------------------------------------------------------------------

async function scenario1StaticLoad(): Promise<void> {
  section('1. Static load + React app boot')

  if (!ctx.server) throw new Error('server not initialized')

  // P6-E #1: production-parity — Nitro at :9090 serving built static/dist/.
  // Default route is `/` (runs list). Implementer must confirm at handoff.
  const runsListUrl = `${ctx.server.baseUrl}/`

  const page = await newPage()
  let response: import('playwright').Response | null = null
  try {
    response = await page.goto(runsListUrl, {
      waitUntil: 'networkidle',
      timeout: STATIC_TIMEOUT_MS,
    })
  } catch (e) {
    info(`page.goto threw: ${(e as Error).message}`)
  }

  assert(response?.status() === 200, `GET ${runsListUrl} returns 200 (got ${response?.status()})`)

  // P6-E #1: confirm runs-list-root mounted (locked testid contract).
  // const runsListRoot = page.locator('[data-testid="runs-list-root"]')
  // await runsListRoot.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
  // assert(await runsListRoot.isVisible(), 'runs-list-root rendered')

  // Forbidden console errors check
  const forbidden = findForbiddenErrors(ctx.consoleErrors)
  assert(
    forbidden.length === 0,
    `no forbidden console errors on static load (got ${forbidden.length}: ${forbidden.map(f => f.kind).join(', ')})`,
  )
  if (forbidden.length > 0) {
    for (const f of forbidden) info(`  ${f.kind}: ${f.msg.slice(0, 200)}`)
  }

  await page.close()
}

// ---------------------------------------------------------------------------
// Scenario 2 — Live streaming via useChat
// P6-E assertion #2: kick off XHS scroll, browser updates live, text
// accumulates, tool cards appear.
// ---------------------------------------------------------------------------

async function scenario2LiveStreaming(): Promise<void> {
  section('2. Live streaming via useChat (XHS scroll on phone-4)')

  if (!ctx.server) throw new Error('server not initialized')

  // P6-E #2: Start a run via UI (new-run modal) OR via API. Handoff will
  // confirm which path is canonical. For now use the API path so the test
  // is decoupled from modal behavior (modal is exercised in scenario 6's
  // CLI parity, which uses the same POST under the hood).
  const startResp = await startRun({
    baseUrl: ctx.server.baseUrl,
    account: ACCOUNT_ID,
    team: TEAM_NAME,
    prompt: PROMPT_STREAMING,
  })
  info(`started run ${startResp.runId}`)

  const runUrl = `${ctx.server.baseUrl}/runs/${startResp.runId}`
  const page = await newPage()

  try {
    await page.goto(runUrl, { waitUntil: 'domcontentloaded', timeout: STATIC_TIMEOUT_MS })
  } catch (e) {
    info(`page.goto ${runUrl} threw: ${(e as Error).message}`)
  }

  // P6-E #2: assert text accumulates + tool-call-card appears.
  // Pseudocode using locked testids:
  //   const messages = page.locator('[data-testid="assistant-message"]')
  //   const toolCards = page.locator('[data-testid="tool-call-card"]')
  //   let lastLen = 0
  //   let lengthGrew = false
  //   for (let i = 0; i < STREAMING_TIMEOUT_MS / 1000; i++) {
  //     const text = await messages.first().innerText().catch(() => '')
  //     if (text.length > lastLen + 10) { lastLen = text.length; lengthGrew = true }
  //     if (await toolCards.count() > 0 && lengthGrew) break
  //     await page.waitForTimeout(1000)
  //   }
  //   assert(lastLen > 0, 'assistant-message accumulated > 0 chars')
  //   assert(lengthGrew, 'assistant-message length grew across samples (streaming, not batched)')
  //   assert(await toolCards.count() > 0, 'at least one tool-call-card rendered')
  //
  // Then wait for run to reach completion via run-status testid:
  //   await page.locator('[data-testid="run-status"]').filter({ hasText: 'completed' }).waitFor(...)
  //
  // Phase 5 false-pass lesson: ALSO verify actual work happened by reading
  // run.json from disk + asserting turnCount > 0 + finalText non-empty +
  // expected v7 chunk types (tool-input-{start,delta,available} +
  // tool-output-available) appear in the chunk log.

  info(`(stub) live streaming assertions pending implementer handoff`)
  // Cancel the run to keep the test-suite teardown fast.
  await fetch(`${ctx.server.baseUrl}/api/v1/runs/${startResp.runId}/cancel`, {
    method: 'POST',
  }).catch(() => {})
  await page.close()
}

// ---------------------------------------------------------------------------
// Scenario 3 — Approval-from-UI via addToolApprovalResponse
// P6-E assertion #3: --require-approval scenario, browser shows approval
// card (data-testid="approval-card"), click Approve → run resumes →
// completes. Replaces P3's signal-card flow.
// ---------------------------------------------------------------------------

async function scenario3ApprovalFromUI(): Promise<void> {
  section('3. Approval-from-UI via addToolApprovalResponse')

  if (!ctx.server) throw new Error('server not initialized')

  // P6-E #3: Start run. Approval driven by bash tool's needsApproval predicate
  // (mutating actions). PROMPT_APPROVAL ("tap any feed item") triggers a
  // mutating tap → workflow run terminates → conversation history holds the
  // tool-approval-request. UI's useChat surfaces this via approval-card.
  //
  // 1. POST /api/v1/runs → runId
  // 2. Navigate to /runs/:id
  // 3. Wait for [data-testid="approval-card"] to appear
  // 4. Verify it contains the tool args (e.g., the bash command preview)
  // 5. Click [data-testid="approval-approve"]
  //    → useChat.addToolApprovalResponse(...) adds tool-approval-response
  //      to messages, then POST /api/v1/runs/:id/messages with full history.
  //      Server's WorkflowAgent collects approvals via
  //      collectToolApprovalsFromMessages → fresh workflow run continues.
  // 6. Assert subsequent chunks arrive and run reaches data-run-completed
  //    (poll [data-testid="run-status"]).
  // 7. Verify run.json: status=completed, turnCount > 0, finalText non-empty.
  //    Phase 5 false-pass lesson — completion alone isn't enough.
  //
  // Locked testids:
  //   - approval-card (container — AI SDK UI Elements primitive, NOT old custom signal card)
  //   - approval-approve / approval-deny / approval-skip (buttons)

  info(`(stub) approval-from-UI assertions pending implementer handoff`)
}

// ---------------------------------------------------------------------------
// Scenario 4 — data-phone-action cards render
// P6-E assertion #4: phone-action card with 3 thumbnails + modal
// navigation.
// ---------------------------------------------------------------------------

async function scenario4PhoneActionCards(): Promise<void> {
  section('4. data-phone-action cards render (3 thumbnails + modal)')

  if (!ctx.server) throw new Error('server not initialized')

  // P6-E #4: Run a scenario that produces a phone-action chunk (any
  // mutating tap). The auto-screenshot wrapper (src/sandbox/build-fs.ts from
  // P2) emits data-phone-action chunks (now via DATA namespace per task #1
  // locked decision) with before/annotated/after URLs.
  //
  // This scenario can piggyback on the approval scenario's run (after
  // approving a mutating tap, the action emits data-phone-action). To keep
  // assertions independent, kick off a fresh run here and wait for
  // phone-action-card to appear.
  //
  // Assertions (locked testids):
  //   - [data-testid="phone-action-card"] count >= 1
  //   - Inside each:
  //       [data-testid="phone-action-thumb-before"]
  //       [data-testid="phone-action-thumb-annotated"]
  //       [data-testid="phone-action-thumb-after"]
  //     are all <img> tags with non-empty src
  //   - Click thumb-before → modal appears (modal testid TBD by implementer
  //     — not in locked contract, ask at handoff)
  //   - Modal navigation: prev/next buttons cycle through the three images
  //   - Click outside modal / press Escape → modal closes

  info(`(stub) phone-action card assertions pending implementer handoff`)
}

// ---------------------------------------------------------------------------
// Scenario 5 — Durability across server restart  (CRITICAL)
// P6-E assertion #5: kill orch container at approval pause, restart on
// same data dir, refresh browser, click Approve, run completes.
// Proves WorkflowAgent migration didn't lose durable suspension.
// ---------------------------------------------------------------------------

async function scenario5DurabilityAcrossRestart(): Promise<void> {
  section('5. Durability across server restart (CRITICAL)')

  // P6-E #5 (CRITICAL): own fresh tmpDir + server because we kill + restart
  // mid-run. Pattern:
  //
  //   1. Spawn server v1 on a fresh tmpDir-d
  //   2. Bootstrap inline (seed-team + add-account)
  //   3. Open browser, POST /api/v1/runs, navigate to /runs/:id
  //   4. Wait for [data-testid="approval-card"] to appear
  //   5. server.kill() (SIGTERM, then SIGKILL after grace)
  //   6. Verify GET /runs/:id is unreachable (server v1 dead)
  //   7. Spawn server v2 on the SAME tmpDir-d (same data dir = persisted
  //      RunStore.messages with the tool-approval-request in history)
  //   8. Wait for server v2 ready
  //   9. Refresh browser (page.reload()) — useChat re-fetches messages from
  //      RunStore via initial GET, sees the tool-approval-request, renders
  //      approval-card again.
  //  10. Verify approval-card is STILL present after reload.
  //      Per task #1 locked decision: under WorkflowAgent + needsApproval,
  //      the workflow run terminates at approval; state lives in conversation
  //      history (RunStore.messages). Restart-then-approve = POST /messages
  //      with updated history → fresh workflow run continues.
  //  11. Click [data-testid="approval-approve"]
  //  12. Wait for [data-testid="run-status"] = completed
  //  13. Assert run.json: status=completed, turnCount > 0, finalText non-empty
  //      (Phase 5 false-pass lesson)
  //  14. Cleanup the second server (first was killed in step 5)
  //
  // This is the CRITICAL scenario — proves the migration preserved durable
  // approval suspension. Phase 3 had it via signal hooks; P6 does it via
  // WorkflowAgent's terminate-and-resume conversation model.

  info(`(stub) durability-across-restart assertions pending implementer handoff`)
}

// ---------------------------------------------------------------------------
// Scenario 6 — CLI parity (`runs create`)
// P6-E assertion #6: `pnpm orchestrator runs create` prints valid URL,
// exits 0. Replaces removed `agent run`.
// ---------------------------------------------------------------------------

async function scenario6CliParity(): Promise<void> {
  section('6. CLI parity — `runs create` prints valid URL, exits 0')

  if (!ctx.server) throw new Error('server not initialized')

  // P6-E #6: command is `runs create`. NOTE: NO --prompt flag — browser-only
  // entry per locked CLI surface in task #1 (C4). Asserts:
  //   - exit 0
  //   - stdout matches https?://.* /runs/[A-Z0-9]+
  //   - GET on the URL returns 200 HTML containing React root
  //   - GET /api/v1/runs/<id> returns 200 with status created|running
  //
  // Pseudocode:
  //   const result = await runOrchestratorCli([
  //     'runs', 'create',
  //     '--account', ACCOUNT_ID,
  //     '--team', TEAM_NAME,
  //   ], { ORCHESTRATOR_DATA_DIR: ctx.tmpDir })
  //   assert(result.status === 0, 'runs create exits 0')
  //   const urlMatch = result.stdout.match(/https?:\/\/\S*\/runs\/([A-Z0-9]+)/)
  //   assert(urlMatch !== null, `stdout contains /runs/<ulid> URL (got ${result.stdout.slice(0, 200)})`)
  //   const url = urlMatch![0]
  //   const runId = urlMatch![1]
  //   const html = await fetch(url)
  //   assert(html.status === 200, `GET ${url} returns 200`)
  //   const htmlBody = await html.text()
  //   assert(htmlBody.includes('id="root"') || /react/i.test(htmlBody), 'response contains React root')
  //   const apiRes = await fetch(`${ctx.server.baseUrl}/api/v1/runs/${runId}`)
  //   assert(apiRes.status === 200, `GET /api/v1/runs/${runId} returns 200`)
  //   const apiBody = await apiRes.json()
  //   assert(['created', 'running'].includes(apiBody.status), `run status is created|running (got ${apiBody.status})`)
  //
  // Note: with no --prompt, the run is created in a "draft" state — user
  // sends the first prompt via the UI's chat input. Confirm with implementer
  // whether `runs create` produces a run that's immediately runnable or one
  // that requires a follow-up POST /messages from the UI.

  info(`(stub) CLI parity assertions pending implementer handoff`)
}

// ---------------------------------------------------------------------------
// Scenario 7 — Regression note
// P6-E assertion #7 is run separately via pnpm test:e2e:phase{1,2,3,5}.
// This script does NOT re-execute them inline (each is 5-50min long).
// The evaluator runs them and includes outputs in the sign-off task update.
// ---------------------------------------------------------------------------

function scenario7RegressionNote(): void {
  section('7. Regression suite (run separately)')
  info('phase1, phase2, phase3, phase5 must be run by the evaluator before sign-off.')
  info('Phase 4 deleted (superseded by P6 — see lead answer to question 6).')
  info('Run: pnpm test:e2e:phase1 && pnpm test:e2e:phase2 && pnpm test:e2e:phase3 && pnpm test:e2e:phase5')
  info('If chunk-type assertions fail because P6 changed shapes (v7 cascading renames per task #13),')
  info('  evaluator files observed-vs-expected; implementer fixes (this is task #13 work).')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await setup()
  try {
    await bootstrap()

    info('spawning orchestrator (Nitro :9090 against tmpDir)')
    ctx.server = await spawnOrch()

    info('launching Playwright Chromium')
    const { browser, context: bctx } = await launchBrowser()
    ctx.browser = browser
    ctx.context = bctx

    await scenario1StaticLoad()
    await scenario2LiveStreaming()
    await scenario3ApprovalFromUI()
    await scenario4PhoneActionCards()
    await scenario5DurabilityAcrossRestart()
    await scenario6CliParity()
    scenario7RegressionNote()
  } finally {
    await teardown()
  }

  console.log(`\n=== Phase 6 e2e summary ===`)
  console.log(`  passed: ${passed}`)
  console.log(`  failed: ${failed}`)
  if (failed > 0) {
    console.log(`\n  failures:`)
    for (const f of failures) console.log(`    - ${f}`)
    process.exit(1)
  }
  // Skeleton exit: when stubs are still in place, we explicitly exit 2 so
  // a CI run flags "skeleton not yet wired". Once assertions are filled in
  // and pass, this block goes away.
  if (process.env.PHASE6_ALLOW_SKELETON_EXIT === '1') {
    console.log(`  PHASE6_ALLOW_SKELETON_EXIT=1 — exiting 0 despite stubbed assertions`)
    process.exit(0)
  }
  console.log(`\n  NOTE: this is a SKELETON. Assertions are stubbed pending implementer-2 handoff on #15.`)
  console.log(`  Set PHASE6_ALLOW_SKELETON_EXIT=1 to silence this and exit 0.`)
  process.exit(2)
}

main().catch(err => {
  console.error('phase6 runner threw:', err)
  void teardown().finally(() => process.exit(1))
})
