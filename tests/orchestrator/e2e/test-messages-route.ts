/**
 * E2E test for `POST /api/v1/runs/:id/messages` user-message inbox route.
 *
 * Exercises:
 *   - 200 + persisted record on a non-terminal run (file lands on disk)
 *   - 400 on missing/empty content
 *   - 404 on unknown run id
 *   - 409 on terminal run (completed/failed/cancelled)
 *   - Multiple enqueue → all entries on disk in FIFO order
 *
 * Pure HTTP/FS — no phone, no LLM, no Workflow SDK loop.
 *
 * Run: pnpm test:e2e:messages-route
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnServer, type SpawnedServer } from './helpers/run-and-tail.js'

const PORT = process.env.MESSAGES_ROUTE_PORT ?? '9092'

let passed = 0
let failed = 0

function assert(cond: unknown, msg: string): void {
  if (cond) { console.log(`  PASS  ${msg}`); passed++ }
  else { console.log(`  FAIL  ${msg}`); failed++ }
}

interface Ctx { tmpDir: string; server: SpawnedServer | null }
const ctx: Ctx = { tmpDir: '', server: null }

const RUN_ID = '01KQEZ0000000000000000RUN1'

interface RunJson {
  id: string
  account: string
  team: string
  agentRole: string
  model: string
  status: string
  startedAt: number
  completedAt: number | null
  workflowRunId?: string | null
  promptTemplatePaths?: string[]
  promptSnapshotPath?: string | null
  initialPrompt?: string | null
  finalText?: string | null
  error?: string | null
  turnCount?: number
}

function writeRunFixture(dir: string, runId: string, status: string): void {
  const runDir = path.join(dir, 'runs', runId)
  fs.mkdirSync(runDir, { recursive: true })
  const run: RunJson = {
    id: runId,
    account: 'p3test:alice',
    team: 'social-media-engagement',
    agentRole: 'engagement-lead',
    model: 'alibaba/qwen3.6-plus',
    status,
    startedAt: Date.now(),
    completedAt: status === 'completed' || status === 'failed' || status === 'cancelled' ? Date.now() : null,
    workflowRunId: null,
    promptTemplatePaths: [],
    promptSnapshotPath: null,
    initialPrompt: null,
    finalText: null,
    error: null,
    turnCount: 0,
  }
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run, null, 2))
}

async function setup(): Promise<void> {
  ctx.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-messages-route-'))
  console.log(`\n=== messages-route e2e ===`)
  console.log(`tmpDir = ${ctx.tmpDir}`)
  // Pre-populate one running + one terminal run.
  writeRunFixture(ctx.tmpDir, RUN_ID, 'running')
  writeRunFixture(ctx.tmpDir, '01KQEZ0000000000000000DONE', 'completed')
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

  // ── 200 on running run ───────────────────────────────────
  {
    const r = await fetch(`${base}/api/v1/runs/${RUN_ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello agent' }),
    })
    assert(r.status === 200, `POST /messages on running run returns 200 (got ${r.status})`)
    const body = await r.json() as { message: { id: string; content: string; ts: number } }
    assert(typeof body.message?.id === 'string' && body.message.id.length > 0, 'response carries message.id (ULID)')
    assert(body.message?.content === 'hello agent', 'response carries the original content')
    assert(typeof body.message?.ts === 'number' && body.message.ts > 0, 'response carries ts')
  }

  // ── file lands on disk ───────────────────────────────────
  {
    const inbox = path.join(ctx.tmpDir, 'runs', RUN_ID, 'messages-inbox.jsonl')
    assert(fs.existsSync(inbox), `inbox file ${inbox} exists after POST`)
    const lines = fs.readFileSync(inbox, 'utf-8').trim().split('\n').filter(Boolean)
    assert(lines.length === 1, `inbox has 1 line (got ${lines.length})`)
    const parsed = JSON.parse(lines[0]) as { content: string }
    assert(parsed.content === 'hello agent', 'inbox content matches POST body')
  }

  // ── multiple enqueue, FIFO order ─────────────────────────
  {
    const r2 = await fetch(`${base}/api/v1/runs/${RUN_ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'second message' }),
    })
    assert(r2.status === 200, `POST /messages second time returns 200 (got ${r2.status})`)
    await r2.arrayBuffer()
    const r3 = await fetch(`${base}/api/v1/runs/${RUN_ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'third' }),
    })
    assert(r3.status === 200, `POST /messages third time returns 200 (got ${r3.status})`)
    await r3.arrayBuffer()

    const inbox = path.join(ctx.tmpDir, 'runs', RUN_ID, 'messages-inbox.jsonl')
    const lines = fs.readFileSync(inbox, 'utf-8').trim().split('\n').filter(Boolean)
    assert(lines.length === 3, `inbox has 3 lines (got ${lines.length})`)
    const contents = lines.map(l => (JSON.parse(l) as { content: string }).content)
    assert(
      contents[0] === 'hello agent' && contents[1] === 'second message' && contents[2] === 'third',
      'inbox preserves FIFO order',
    )
  }

  // ── 400 on empty content ─────────────────────────────────
  {
    const r = await fetch(`${base}/api/v1/runs/${RUN_ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    })
    assert(r.status === 400, `POST /messages with empty content returns 400 (got ${r.status})`)
    await r.arrayBuffer()
  }

  // ── 400 on missing content ───────────────────────────────
  {
    const r = await fetch(`${base}/api/v1/runs/${RUN_ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert(r.status === 400, `POST /messages with no content returns 400 (got ${r.status})`)
    await r.arrayBuffer()
  }

  // ── 404 on unknown run ───────────────────────────────────
  {
    const r = await fetch(`${base}/api/v1/runs/01KQEZ0000000000000NOTHING/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    })
    assert(r.status === 404, `POST /messages on unknown run returns 404 (got ${r.status})`)
    await r.arrayBuffer()
  }

  // ── 409 on terminal run ──────────────────────────────────
  {
    const r = await fetch(`${base}/api/v1/runs/01KQEZ0000000000000000DONE/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'too late' }),
    })
    assert(r.status === 409, `POST /messages on completed run returns 409 (got ${r.status})`)
    const body = await r.json().catch(() => ({})) as { statusMessage?: string }
    void body
  }

  console.log(`\n${passed} passed, ${failed} failed`)
}

main()
  .then(async () => { await teardown(); process.exit(failed === 0 ? 0 : 1) })
  .catch(async (e) => { console.error(e); await teardown(); process.exit(1) })
