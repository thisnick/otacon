/**
 * E2E test for the Phase 4 web UI (P4-I).
 *
 * Lightweight in lieu of Playwright (which the plan calls for in
 * `phase4-ui.ts` but is still pending as a separate evaluator task —
 * adding Chromium binaries is out of scope here). This test:
 *
 *   1. Spawns the Nitro server
 *   2. GETs `/` (index.html) and `/run.html` — confirms 200 + correct
 *      content-type + load-bearing markers (data-testid, key element ids)
 *   3. Confirms the API endpoints the UI relies on (/runs, /runs/:id,
 *      /runs/:id/prompt) still work alongside the static serve
 *   4. Confirms the static serve doesn't shadow `/api/v1/*` or `/health`
 *
 * Real browser-driven testing is the evaluator's job in P4-E
 * (`phase4-ui.ts` with Playwright). This in-process test catches the
 * obvious wiring breaks (missing files, mis-configured publicAssets,
 * route shadowing).
 *
 * Run: pnpm test:e2e:web-ui
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnServer, type SpawnedServer } from './helpers/run-and-tail.js'

const PORT = process.env.WEB_UI_PORT ?? '9090'
const RUN_ID = '01KQF000000000000000WEBUI1'
const ACCOUNT_ID = 'webui-test:alice'
const TEAM_NAME = 'social-media-engagement'

let passed = 0
let failed = 0

function assert(cond: unknown, msg: string): void {
  if (cond) { console.log(`  PASS  ${msg}`); passed++ }
  else { console.log(`  FAIL  ${msg}`); failed++ }
}

interface Ctx { tmpDir: string; server: SpawnedServer | null }
const ctx: Ctx = { tmpDir: '', server: null }

function writeRunFixture(): void {
  const runDir = path.join(ctx.tmpDir, 'runs', RUN_ID)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
    id: RUN_ID,
    account: ACCOUNT_ID,
    team: TEAM_NAME,
    agentRole: 'engagement-lead',
    model: 'alibaba/qwen3.6-plus',
    status: 'completed',
    startedAt: Date.now() - 60_000,
    completedAt: Date.now() - 5_000,
    workflowRunId: null,
    promptTemplatePaths: [],
    promptSnapshotPath: null,
    initialPrompt: 'open xhs and scroll once',
    finalText: 'done',
    error: null,
    turnCount: 4,
  }, null, 2))
  fs.writeFileSync(path.join(runDir, 'prompt.md'), '# system prompt\nYou are a helpful agent.\n')
  fs.mkdirSync(path.join(ctx.tmpDir, 'index'), { recursive: true })
  fs.appendFileSync(path.join(ctx.tmpDir, 'index', 'runs.jsonl'),
    JSON.stringify({ id: RUN_ID, account: ACCOUNT_ID, team: TEAM_NAME, status: 'completed', startedAt: Date.now() - 60_000 }) + '\n')
}

async function setup(): Promise<void> {
  ctx.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-web-ui-'))
  console.log(`\n=== web-ui e2e ===`)
  console.log(`tmpDir = ${ctx.tmpDir}`)
  writeRunFixture()
}

async function teardown(): Promise<void> {
  try { if (ctx.server) await ctx.server.kill() } catch (e) { console.error('teardown server kill failed', e) }
  try { if (ctx.tmpDir && fs.existsSync(ctx.tmpDir)) fs.rmSync(ctx.tmpDir, { recursive: true, force: true }) }
  catch (e) { console.error('teardown tmpDir cleanup failed', e) }
}

async function main(): Promise<void> {
  await setup()
  ctx.server = await spawnServer({
    port: PORT,
    dataDir: ctx.tmpDir,
    logPrefix: '[server]',
    readyTimeoutMs: 120_000,
  })
  const base = ctx.server.baseUrl

  // ── GET / serves index.html ─────────────────────────────
  {
    const r = await fetch(`${base}/`)
    assert(r.status === 200, `GET / returns 200 (got ${r.status})`)
    assert(
      (r.headers.get('content-type') ?? '').includes('text/html'),
      `GET / content-type=text/html (got ${r.headers.get('content-type')})`,
    )
    const body = await r.text()
    assert(body.includes('<!DOCTYPE html>'), 'GET / body starts with <!DOCTYPE html>')
    assert(body.includes('Otacon Orchestrator'), 'GET / body has page title')
    assert(body.includes('data-testid="otacon-orchestrator-runs"'), 'GET / body has data-testid for runs page')
    assert(body.includes('id="runs-body"'), 'GET / body has #runs-body table target')
    assert(body.includes('/api/v1/runs'), 'GET / body references the runs API')
  }

  // ── GET /run.html serves run.html ───────────────────────
  {
    const r = await fetch(`${base}/run.html`)
    assert(r.status === 200, `GET /run.html returns 200 (got ${r.status})`)
    const body = await r.text()
    assert(body.includes('data-testid="otacon-orchestrator-run"'), 'run.html has data-testid for run page')
    assert(body.includes('id="timeline"'), 'run.html has #timeline')
    assert(body.includes('id="run-header"'), 'run.html has #run-header')
    assert(body.includes('EventSource'), 'run.html uses EventSource for live tail')
    assert(body.includes('/api/v1/signals/'), 'run.html POSTs to signals/:id/resolve')
    assert(body.includes('data-cat="phone-action"'), 'run.html has phone-action filter checkbox')
    assert(body.includes('data-cat="approval"'), 'run.html has approval filter checkbox')
    assert(body.includes('btn-prompt'), 'run.html has the View prompt button')
  }

  // ── 404 on missing static file ──────────────────────────
  {
    const r = await fetch(`${base}/nonexistent.html`)
    assert(r.status === 404, `GET /nonexistent.html returns 404 (got ${r.status})`)
    await r.arrayBuffer()
  }

  // ── API still works alongside static ────────────────────
  {
    const r = await fetch(`${base}/api/v1/runs`)
    assert(r.status === 200, `GET /api/v1/runs returns 200 (got ${r.status})`)
    const body = await r.json() as { runs: Array<{ id: string }> }
    assert(Array.isArray(body.runs), 'GET /api/v1/runs returns {runs: array}')
    assert(body.runs.some(r => r.id === RUN_ID), `runs list includes ${RUN_ID}`)
  }
  {
    const r = await fetch(`${base}/api/v1/runs/${encodeURIComponent(RUN_ID)}`)
    assert(r.status === 200, `GET /api/v1/runs/:id returns 200 (got ${r.status})`)
    const run = await r.json() as { id: string; status: string }
    assert(run.id === RUN_ID, `GET /api/v1/runs/:id returns id=${RUN_ID}`)
    assert(run.status === 'completed', 'run metadata reflects fixture status')
  }
  {
    const r = await fetch(`${base}/api/v1/runs/${encodeURIComponent(RUN_ID)}/prompt`)
    assert(r.status === 200, `GET /api/v1/runs/:id/prompt returns 200 (got ${r.status})`)
    const text = await r.text()
    assert(text.includes('You are a helpful agent'), 'GET /prompt returns the snapshot')
  }
  {
    const r = await fetch(`${base}/health`)
    assert(r.status === 200, `GET /health returns 200 (got ${r.status})`)
    const body = await r.json() as { ok: boolean }
    assert(body.ok === true, '/health returns {ok: true}')
  }

  // ── /index.html also serves ─────────────────────────────
  {
    const r = await fetch(`${base}/index.html`)
    assert(r.status === 200, `GET /index.html returns 200 (got ${r.status})`)
    await r.arrayBuffer()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
}

main()
  .then(async () => { await teardown(); process.exit(failed === 0 ? 0 : 1) })
  .catch(async (e) => { console.error(e); await teardown(); process.exit(1) })
