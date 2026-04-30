/**
 * Helper for orchestrator-v2 e2e tests that spawn a Nitro server and run the
 * `agent run-v2` CLI client against it.
 *
 * Two surfaces:
 *
 *   spawnServer(opts) → starts `pnpm dev` in a child process, waits for
 *     /api/v1/runs to respond (any non-5xx). Returns a handle with `kill()`.
 *
 *   tailRun(opts) → starts a run via POST /api/v1/runs, opens the SSE stream,
 *     yields chunks one at a time. Optionally auto-resolves approval signals.
 *     Caller terminates by breaking out of the loop on a terminal chunk.
 *
 * Hermetic: the test owns the data dir + port; teardown is the test's job.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface SpawnedServer {
  proc: ChildProcess
  baseUrl: string
  kill: () => Promise<void>
}

export interface SpawnServerOpts {
  port: string
  dataDir: string
  /** Extra env vars passed through to the server process. */
  env?: NodeJS.ProcessEnv
  /** Probe URL to confirm the server is ready. Defaults to /api/v1/runs (POST). */
  readyCheck?: { url: string; method?: 'GET' | 'POST'; body?: string }
  /** Timeout in ms waiting for ready. Default 90s — Nitro warmup is slow. */
  readyTimeoutMs?: number
  /** If set, prefix server stdout/stderr lines with this label on the parent's stderr. */
  logPrefix?: string
}

export async function spawnServer(opts: SpawnServerOpts): Promise<SpawnedServer> {
  const orchDir = path.resolve(__dirname, '../../../../src/orchestrator')
  const baseUrl = `http://localhost:${opts.port}`

  const proc = spawn('pnpm', ['dev'], {
    cwd: orchDir,
    env: {
      ...process.env,
      PORT: opts.port,
      ORCHESTRATOR_DATA_DIR: opts.dataDir,
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const prefix = opts.logPrefix ?? '[server]'
  proc.stdout?.on('data', b => process.stderr.write(`${prefix} ${b}`))
  proc.stderr?.on('data', b => process.stderr.write(`${prefix} ${b}`))

  const ready = opts.readyCheck ?? {
    url: `${baseUrl}/api/v1/runs`,
    method: 'POST',
    body: '{}',
  }
  const timeout = opts.readyTimeoutMs ?? 90_000
  await waitForReady(ready.url, ready.method ?? 'POST', ready.body ?? '{}', timeout)

  const kill = async () => {
    if (proc.killed) return
    proc.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 500))
    if (!proc.killed) proc.kill('SIGKILL')
  }

  return { proc, baseUrl, kill }
}

async function waitForReady(
  url: string,
  method: 'GET' | 'POST',
  body: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res =
        method === 'POST'
          ? await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
            })
          : await fetch(url, { method: 'GET' })
      if (res.status < 500) return
    } catch {
      // not ready
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`server at ${url} never became ready within ${timeoutMs}ms`)
}

export interface UIMessageChunk {
  type: string
  id?: string
  // various per-type fields
  [key: string]: unknown
}

export interface StartRunArgs {
  baseUrl: string
  account: string
  team?: string
  prompt?: string
}

export interface StartRunResponse {
  runId: string
  workflowRunId: string
}

/** POST /api/v1/runs and return {runId, workflowRunId}. */
export async function startRun(args: StartRunArgs): Promise<StartRunResponse> {
  const res = await fetch(`${args.baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      account: args.account,
      team: args.team,
      prompt: args.prompt,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`POST /api/v1/runs failed: ${res.status} ${res.statusText}\n${body}`)
  }
  return (await res.json()) as StartRunResponse
}

export interface TailRunOpts {
  baseUrl: string
  runId: string
  startIndex?: number
  /** If true, POST /api/v1/signals/{id}/resolve {decision: "approve"} when a data-signal-created chunk arrives. */
  autoApprove?: boolean
  /** Stop reading at the first terminal chunk. Default true. */
  stopOnTerminal?: boolean
  /** Hard timeout for the whole tail. Default 15min — agent loops on phone-3 are slow. */
  timeoutMs?: number
  /** Optional callback for every chunk before yield (e.g., to log progress). */
  onChunk?: (chunk: UIMessageChunk) => void
}

const TERMINAL_TYPES = new Set(['data-run-completed', 'data-run-failed', 'data-run-cancelled'])

export interface TailResult {
  chunks: UIMessageChunk[]
  terminal: UIMessageChunk | null
  /** Headers from the SSE response — useful for x-workflow-run-id, x-workflow-stream-tail-index. */
  headers: Record<string, string>
}

/**
 * Tail an existing run. Posts approval-resolve when autoApprove=true and a
 * data-signal-created chunk arrives. Returns when a terminal chunk is seen
 * or the timeout fires.
 */
export async function tailRun(opts: TailRunOpts): Promise<TailResult> {
  const startIndex = opts.startIndex ?? 0
  const url = `${opts.baseUrl}/api/v1/runs/${opts.runId}/stream?startIndex=${startIndex}`
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
  })
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}\n${body}`)
  }

  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    headers[k] = v
  })

  const chunks: UIMessageChunk[] = []
  let terminal: UIMessageChunk | null = null
  const stopOnTerminal = opts.stopOnTerminal ?? true
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000

  let timer: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tailRun timeout after ${timeoutMs}ms`)), timeoutMs)
  })

  try {
    await Promise.race([
      timeoutPromise,
      (async () => {
        for await (const chunk of parseSse(res.body as ReadableStream<Uint8Array>)) {
          chunks.push(chunk)
          if (opts.onChunk) opts.onChunk(chunk)

          if (chunk.type === 'data-signal-created' && opts.autoApprove) {
            const signalId = extractSignalId(chunk)
            if (signalId) {
              await resolveSignal({
                baseUrl: opts.baseUrl,
                signalId,
                decision: 'approve',
              })
            }
          }

          if (TERMINAL_TYPES.has(chunk.type)) {
            terminal = chunk
            if (stopOnTerminal) break
          }
        }
      })(),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }

  return { chunks, terminal, headers }
}

function extractSignalId(chunk: UIMessageChunk): string | null {
  const data = (chunk as { data?: Record<string, unknown> }).data
  if (!data) return null
  const candidates = ['signalId', 'signal_id', 'id']
  for (const k of candidates) {
    const v = data[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

export async function resolveSignal(args: {
  baseUrl: string
  signalId: string
  decision: 'approve' | 'reject' | 'skip'
  message?: string
}): Promise<{ status: number }> {
  const res = await fetch(`${args.baseUrl}/api/v1/signals/${args.signalId}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: args.decision, message: args.message }),
  })
  return { status: res.status }
}

/** Parse SSE bytes → UIMessageChunk JSON objects. Each event: `data: <JSON>\n\n`. */
async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<UIMessageChunk> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = findEventBoundary(buffer)) >= 0) {
        const event = buffer.slice(0, idx)
        buffer = buffer.slice(idx).replace(/^(\r?\n){2}/, '')
        const parsed = parseEvent(event)
        if (parsed) yield parsed
      }
    }
    const trailing = buffer.trim()
    if (trailing) {
      const parsed = parseEvent(trailing)
      if (parsed) yield parsed
    }
  } finally {
    reader.releaseLock()
  }
}

function findEventBoundary(s: string): number {
  const a = s.indexOf('\n\n')
  const b = s.indexOf('\r\n\r\n')
  if (a === -1) return b
  if (b === -1) return a
  return Math.min(a, b)
}

function parseEvent(raw: string): UIMessageChunk | null {
  const dataLines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  if (dataLines.length === 0) return null
  const json = dataLines.join('\n')
  try {
    return JSON.parse(json) as UIMessageChunk
  } catch {
    return null
  }
}
