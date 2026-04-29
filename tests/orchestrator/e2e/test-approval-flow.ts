/**
 * Control-flow e2e for orchestrator-v2 commit 7a.
 *
 * Verifies CLI ↔ server ↔ workflow ↔ approval ↔ stream replay works
 * end-to-end without DurableAgent or phone hardware:
 *
 *   1. Spawn `pnpm dev` against a clean tmp data dir.
 *   2. POST /__test/approval-flow → start an approvalFlowWorkflow run.
 *   3. Tail /api/v1/runs/:id/stream → expect lifecycle + signal chunks.
 *   4. On `data-signal-created`, POST /api/v1/signals/:id/resolve.
 *   5. Verify the workflow resumes, emits data-signal-resolved + data-run-completed.
 *   6. Verify the SignalStore record exists and is marked resolved.
 *
 * Hardware required: none. No phone, no LLM, no registry.
 *
 * Run: `cd src/orchestrator && pnpm test:e2e:approval-flow`
 *      or `pnpm test` (now includes this).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = process.env.APPROVAL_FLOW_PORT ?? '9096'
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-approval-e2e-'))
  const here = path.dirname(fileURLToPath(import.meta.url))
  const orchDir = path.resolve(here, '../../../src/orchestrator')

  server = spawn('pnpm', ['dev'], {
    cwd: orchDir,
    env: { ...process.env, PORT, ORCHESTRATOR_DATA_DIR: tmpDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout?.on('data', (b) => process.stderr.write(`[server] ${b}`))
  server.stderr?.on('data', (b) => process.stderr.write(`[server] ${b}`))
  await waitFor(`${BASE}/__test/approval-flow`, 90_000)
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
  // ai SDK shape props
  delta?: string
  toolName?: string
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
    // Start the test workflow.
    const startRes = await fetch(`${BASE}/__test/approval-flow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'otacon tap eN', rationale: 'integration test' }),
    })
    assert(startRes.status === 200, `POST /__test/approval-flow returns 200 (got ${startRes.status})`)
    const { runId, workflowRunId, toolCallId } = (await startRes.json()) as {
      runId: string; workflowRunId: string; toolCallId: string
    }
    assert(typeof runId === 'string' && runId.length > 0, `got runId: ${runId}`)
    assert(typeof workflowRunId === 'string' && workflowRunId.startsWith('wrun_'), `got workflowRunId: ${workflowRunId}`)

    // Tail the chunk stream. We read incrementally so we can resolve the
    // signal as soon as it appears.
    const streamRes = await fetch(`${BASE}/api/v1/runs/${runId}/stream?startIndex=0`, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    })
    assert(streamRes.status === 200, `GET /api/v1/runs/:id/stream returns 200 (got ${streamRes.status})`)
    assert(streamRes.headers.get('x-workflow-run-id') === workflowRunId, 'x-workflow-run-id header matches workflowRunId')
    assert(streamRes.headers.get('x-workflow-stream-tail-index') !== null, 'x-workflow-stream-tail-index header present')

    if (!streamRes.body) {
      console.error('no stream body, abort')
      failed++
      return
    }

    const observed: SseEvent[] = []
    let signalResolveStatus: number | null = null
    for await (const event of parseSse(streamRes.body as ReadableStream<Uint8Array>)) {
      observed.push(event)
      if (event.type === 'data-signal-created') {
        const signalId = event.data?.signalId
        assert(typeof signalId === 'string', `data-signal-created carries signalId (got ${signalId})`)
        // Resolve via the new HTTP route
        const res = await fetch(`${BASE}/api/v1/signals/${signalId}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision: 'approve', message: 'looks good' }),
        })
        signalResolveStatus = res.status
      }
      if (event.type === 'data-run-completed' || event.type === 'data-run-failed') break
    }

    assert(signalResolveStatus === 200, `signal resolve returns 200 (got ${signalResolveStatus})`)

    const types = observed.map(e => e.type)
    assert(types.includes('data-run-started'), 'observed data-run-started')
    assert(types.includes('data-signal-created'), 'observed data-signal-created')
    assert(types.includes('data-signal-resolved'), 'observed data-signal-resolved')
    assert(types.includes('data-run-completed'), 'observed data-run-completed')
    assert(types[types.length - 1] === 'data-run-completed', 'data-run-completed is the terminal chunk')

    // Verify the signal-resolved chunk carries the decision
    const resolved = observed.find(e => e.type === 'data-signal-resolved')
    assert(resolved?.data?.decision === 'approve', `signal-resolved.data.decision=approve (got ${resolved?.data?.decision})`)

    // Verify SignalStore record on disk
    const signalsDir = path.join(tmpDir, 'runs', runId, 'signals')
    const files = fs.existsSync(signalsDir) ? fs.readdirSync(signalsDir) : []
    assert(files.length === 1, `1 signal file persisted (got ${files.length})`)
    if (files.length === 1) {
      const sig = JSON.parse(fs.readFileSync(path.join(signalsDir, files[0]), 'utf-8'))
      assert(sig.status === 'approved', `signal record marked status=approved (got ${sig.status})`)
      assert(sig.decision === 'approve', `signal record decision=approve (got ${sig.decision})`)
      assert(sig.toolCallId === toolCallId, 'signal record toolCallId matches')
      assert(sig.hookToken.includes(runId) && sig.hookToken.includes(toolCallId), 'signal record hookToken format')
    }

    // Verify run.json reflects the final state
    const runJsonPath = path.join(tmpDir, 'runs', runId, 'run.json')
    const runJson = JSON.parse(fs.readFileSync(runJsonPath, 'utf-8'))
    assert(runJson.workflowRunId === workflowRunId, 'run.json carries workflowRunId after route assignment')
    // Status: route updates to 'running' immediately; the workflow itself
    // doesn't mutate run.json — that's the lead-agent route's job. So
    // running is what we expect here.
    assert(runJson.status === 'running', `run.json status=running (route-assigned; got ${runJson.status})`)
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
