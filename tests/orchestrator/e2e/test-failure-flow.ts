/**
 * Failure-path e2e: a thrown step inside a workflow body should still
 * produce a terminal `data-run-failed` chunk so consumers (CLI/web UI)
 * exit cleanly instead of hanging.
 *
 * Spawns nitro dev → POST /__test/failure-flow → tails the SSE stream →
 * asserts the run terminates with `data-run-failed` carrying the error
 * message we passed in.
 *
 * Hardware required: none.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = process.env.FAILURE_FLOW_PORT ?? '9098'
const BASE = `http://localhost:${PORT}`

let passed = 0
let failed = 0
let server: ChildProcess | null = null
let tmpDir: string

function assert(cond: unknown, msg: string) {
  if (cond) { console.log(`  PASS  ${msg}`); passed++ }
  else { console.log(`  FAIL  ${msg}`); failed++ }
}

async function waitFor(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (r.status < 500) return
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`server at ${url} never became ready within ${timeoutMs}ms`)
}

async function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-failure-e2e-'))
  const here = path.dirname(fileURLToPath(import.meta.url))
  const orchDir = path.resolve(here, '../../../src/orchestrator')

  server = spawn('pnpm', ['dev'], {
    cwd: orchDir,
    env: { ...process.env, PORT, ORCHESTRATOR_DATA_DIR: tmpDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout?.on('data', (b) => process.stderr.write(`[server] ${b}`))
  server.stderr?.on('data', (b) => process.stderr.write(`[server] ${b}`))
  await waitFor(`${BASE}/__test/failure-flow`, 90_000)
}

async function teardown() {
  if (server && !server.killed) {
    server.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 500))
    if (!server.killed) server.kill('SIGKILL')
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

interface SseEvent {
  type: string
  id?: string
  data?: any
}

async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLines: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
        }
        if (dataLines.length === 0) continue
        try { yield JSON.parse(dataLines.join('\n')) as SseEvent } catch { /* skip */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function main() {
  await setup()
  try {
    const errMsg = 'synthetic failure for the failure-flow e2e'
    const startRes = await fetch(`${BASE}/__test/failure-flow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: errMsg }),
    })
    assert(startRes.status === 200, `POST /__test/failure-flow returns 200 (got ${startRes.status})`)
    const { runId } = (await startRes.json()) as { runId: string; workflowRunId: string }

    const streamRes = await fetch(`${BASE}/api/v1/runs/${runId}/stream?startIndex=0`, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    })
    assert(streamRes.status === 200, `GET /api/v1/runs/:id/stream returns 200 (got ${streamRes.status})`)

    if (!streamRes.body) return

    const observed: SseEvent[] = []
    for await (const event of parseSse(streamRes.body as ReadableStream<Uint8Array>)) {
      observed.push(event)
      if (event.type === 'data-run-failed' || event.type === 'data-run-completed') break
    }

    const types = observed.map(e => e.type)
    assert(types.includes('data-run-started'), 'observed data-run-started')
    assert(types.includes('data-run-failed'), 'observed data-run-failed')
    assert(!types.includes('data-run-completed'), 'did NOT observe data-run-completed (failure path)')
    assert(types[types.length - 1] === 'data-run-failed', 'data-run-failed is the terminal chunk')

    const failedChunk = observed.find(e => e.type === 'data-run-failed')
    const carriedError = failedChunk?.data?.error
    assert(typeof carriedError === 'string' && carriedError.includes(errMsg),
      `data-run-failed.data.error carries the original message (got: ${carriedError})`)
  } catch (e: any) {
    console.error('UNCAUGHT:', e?.stack ?? e)
    failed++
  } finally {
    await teardown()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
