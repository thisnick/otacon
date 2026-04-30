/**
 * E2E test for `GET /api/v1/runs/:id/traces/:tcid/:file`.
 *
 * Backs P2's `data-phone-action` chunk URLs. The route reads
 * `<dataDir>/runs/{runId}/traces/{toolCallId}/{file}` from disk and serves
 * it with the right content-type. Allowlist is `before.png`,
 * `annotated.png`, `after.png`, `result.json`.
 *
 * Strategy: pre-populate the run dir with synthetic bytes, spawn the
 * server, fetch each allowlist file + a few negative cases (wrong file,
 * missing file, traversal attempt). No phone, no LLM, no Workflow SDK —
 * pure HTTP/FS test.
 *
 * Run: pnpm test:e2e:trace-route
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnServer, type SpawnedServer } from './helpers/run-and-tail.js'

const PORT = process.env.TRACE_ROUTE_PORT ?? '9094'
const RUN_ID = '01KQE0000000000000000RUNID'   // valid ULID-shape id
const TCID = 'tc-01KQE0000000TCID0000000001'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FAKE_BEFORE = Buffer.concat([PNG_MAGIC, Buffer.from('before-bytes')])
const FAKE_ANNOTATED = Buffer.concat([PNG_MAGIC, Buffer.from('annotated-bytes')])
const FAKE_AFTER = Buffer.concat([PNG_MAGIC, Buffer.from('after-bytes')])
const FAKE_RESULT = { command: 'otacon tap e5', exitCode: 0 }

let passed = 0
let failed = 0

function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  PASS  ${msg}`)
    passed++
  } else {
    console.log(`  FAIL  ${msg}`)
    failed++
  }
}

interface Ctx {
  tmpDir: string
  server: SpawnedServer | null
}
const ctx: Ctx = { tmpDir: '', server: null }

async function setup(): Promise<void> {
  ctx.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-trace-route-'))
  console.log(`\n=== trace-route e2e ===`)
  console.log(`tmpDir = ${ctx.tmpDir}`)
  console.log(`port   = ${PORT}`)

  // Pre-populate the trace dir.
  const traceDir = path.join(ctx.tmpDir, 'runs', RUN_ID, 'traces', TCID)
  fs.mkdirSync(traceDir, { recursive: true })
  fs.writeFileSync(path.join(traceDir, 'before.png'), FAKE_BEFORE)
  fs.writeFileSync(path.join(traceDir, 'annotated.png'), FAKE_ANNOTATED)
  fs.writeFileSync(path.join(traceDir, 'after.png'), FAKE_AFTER)
  fs.writeFileSync(path.join(traceDir, 'result.json'), JSON.stringify(FAKE_RESULT, null, 2))
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

async function main(): Promise<void> {
  await setup()

  ctx.server = await spawnServer({
    port: PORT,
    dataDir: ctx.tmpDir,
    logPrefix: '[server]',
    readyTimeoutMs: 120_000,
  })
  const base = ctx.server.baseUrl

  // ── allowlist files ────────────────────────────────────────
  {
    const res = await fetch(`${base}/api/v1/runs/${RUN_ID}/traces/${TCID}/before.png`)
    assert(res.status === 200, `GET before.png returns 200 (got ${res.status})`)
    assert(
      res.headers.get('content-type') === 'image/png',
      `GET before.png content-type=image/png (got ${res.headers.get('content-type')})`,
    )
    const body = Buffer.from(await res.arrayBuffer())
    assert(body.equals(FAKE_BEFORE), 'GET before.png body matches written bytes')
  }

  {
    const res = await fetch(`${base}/api/v1/runs/${RUN_ID}/traces/${TCID}/annotated.png`)
    assert(res.status === 200, `GET annotated.png returns 200 (got ${res.status})`)
    const body = Buffer.from(await res.arrayBuffer())
    assert(body.equals(FAKE_ANNOTATED), 'GET annotated.png body matches written bytes')
  }

  {
    const res = await fetch(`${base}/api/v1/runs/${RUN_ID}/traces/${TCID}/after.png`)
    assert(res.status === 200, `GET after.png returns 200 (got ${res.status})`)
    const body = Buffer.from(await res.arrayBuffer())
    assert(body.equals(FAKE_AFTER), 'GET after.png body matches written bytes')
  }

  {
    const res = await fetch(`${base}/api/v1/runs/${RUN_ID}/traces/${TCID}/result.json`)
    assert(res.status === 200, `GET result.json returns 200 (got ${res.status})`)
    assert(
      res.headers.get('content-type') === 'application/json',
      `GET result.json content-type=application/json (got ${res.headers.get('content-type')})`,
    )
    const body = await res.json()
    assert(
      JSON.stringify(body) === JSON.stringify(FAKE_RESULT),
      `GET result.json body matches: ${JSON.stringify(body)}`,
    )
  }

  // ── caching headers ────────────────────────────────────────
  {
    const res = await fetch(`${base}/api/v1/runs/${RUN_ID}/traces/${TCID}/before.png`)
    const cacheControl = res.headers.get('cache-control') ?? ''
    assert(
      cacheControl.includes('immutable'),
      `cache-control includes 'immutable' (got ${JSON.stringify(cacheControl)})`,
    )
    assert(
      cacheControl.includes('max-age='),
      `cache-control includes max-age= (got ${JSON.stringify(cacheControl)})`,
    )
    // Drain body to release the connection
    await res.arrayBuffer()
  }

  // ── 404: missing trace file (existing run/tcid, file not on disk) ─
  {
    // Create a sibling tcid with no annotated.png on disk.
    const otherTcid = 'tc-01KQE0000000TCID0000000002'
    fs.mkdirSync(path.join(ctx.tmpDir, 'runs', RUN_ID, 'traces', otherTcid), { recursive: true })
    const res = await fetch(`${base}/api/v1/runs/${RUN_ID}/traces/${otherTcid}/annotated.png`)
    assert(res.status === 404, `GET missing annotated.png returns 404 (got ${res.status})`)
    await res.arrayBuffer()
  }

  // ── 404: unsupported file name (allowlist enforcement) ──────
  {
    const res = await fetch(`${base}/api/v1/runs/${RUN_ID}/traces/${TCID}/secret.txt`)
    assert(res.status === 404, `GET unsupported file (secret.txt) returns 404 (got ${res.status})`)
    await res.arrayBuffer()
  }

  // ── 400: unsafe id (path traversal) ─────────────────────────
  {
    // %2E%2E%2F = "../" — server should refuse before disk access.
    const res = await fetch(`${base}/api/v1/runs/${encodeURIComponent('../etc')}/traces/${TCID}/before.png`)
    assert(
      res.status === 400 || res.status === 404,
      `GET with path-traversal id returns 4xx (got ${res.status})`,
    )
    await res.arrayBuffer()
  }

  // ── 404: nonexistent run ────────────────────────────────────
  {
    const res = await fetch(`${base}/api/v1/runs/01KQE0000000000000NONE/traces/${TCID}/before.png`)
    assert(res.status === 404, `GET on nonexistent run returns 404 (got ${res.status})`)
    await res.arrayBuffer()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
}

main()
  .then(async () => {
    await teardown()
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch(async (e) => {
    console.error(e)
    await teardown()
    process.exit(1)
  })
