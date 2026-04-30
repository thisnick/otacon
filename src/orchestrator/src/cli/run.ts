/**
 * `agent run` — orchestrator CLI client.
 *
 * 1. POST /api/v1/runs to start a workflow run; receive `{runId,
 *    workflowRunId}` back.
 * 2. Open an SSE connection to /api/v1/runs/:id/stream and read
 *    UIMessageChunks. The server wraps the workflow's chunk stream in AI
 *    SDK SSE framing, so each event is `data: <UIMessageChunk JSON>\n\n`.
 * 3. Render chunks as they arrive — text-deltas to stdout, tool calls
 *    one-line, lifecycle markers, phone actions, and approval prompts.
 * 4. On `data-signal-created`, prompt stdin (a/r/s) and POST
 *    /api/v1/signals/:id/resolve.
 * 5. Block until a terminal chunk (`data-run-completed` exit 0,
 *    `data-run-failed` exit 1, `data-run-cancelled` exit 2).
 */
import * as readline from 'node:readline'
import { loadOrchestratorConfig } from '../config.js'

export interface RunOptions {
  account: string
  team?: string
  prompt?: string
  /**
   * Override the resolved orchestrator URL (otherwise from
   * `loadOrchestratorConfig()`: env → toml → default).
   */
  url?: string
  /** Auto-approve every approval signal (no stdin prompt). For test runs. */
  autoApprove?: boolean
}

interface UIMessageChunk {
  type: string
  id?: string
  // Various shapes per chunk type — preserve as unknown.
  [key: string]: unknown
}

interface SignalCreatedData {
  signalId?: string
  signal_id?: string
  signalIdAlt?: string
  toolCallId?: string
  command?: string
  rationale?: string
}

const TERMINAL_TYPES = new Set(['data-run-completed', 'data-run-failed', 'data-run-cancelled'])

export async function runCommand(opts: RunOptions): Promise<void> {
  const cfg = loadOrchestratorConfig()
  const baseUrl = (opts.url ?? cfg.url).replace(/\/$/, '')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`

  // 1. Start the run
  const startRes = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ account: opts.account, team: opts.team, prompt: opts.prompt }),
  })
  if (!startRes.ok) {
    const body = await safeText(startRes)
    throw new Error(`POST /api/v1/runs failed: ${startRes.status} ${startRes.statusText}\n${body}`)
  }
  const { runId, workflowRunId } = (await startRes.json()) as { runId: string; workflowRunId: string }
  console.error(`[run] runId=${runId} workflowRunId=${workflowRunId}`)

  // 2. Tail the chunk stream
  const streamHeaders: Record<string, string> = { accept: 'text/event-stream' }
  if (cfg.token) streamHeaders.authorization = `Bearer ${cfg.token}`
  const streamRes = await fetch(`${baseUrl}/api/v1/runs/${runId}/stream?startIndex=0`, {
    method: 'GET',
    headers: streamHeaders,
  })
  if (!streamRes.ok || !streamRes.body) {
    const body = await safeText(streamRes)
    throw new Error(
      `GET /api/v1/runs/${runId}/stream failed: ${streamRes.status} ${streamRes.statusText}\n${body}`,
    )
  }

  let exitCode = 0
  for await (const chunk of parseSse(streamRes.body)) {
    const handled = await handleChunk({
      chunk,
      runId,
      baseUrl,
      autoApprove: !!opts.autoApprove,
      token: cfg.token,
    })
    if (handled.terminal) {
      exitCode = handled.exitCode ?? 0
      break
    }
  }

  process.exit(exitCode)
}

interface ChunkHandlerResult {
  terminal: boolean
  exitCode?: number
}

async function handleChunk(args: {
  chunk: UIMessageChunk
  runId: string
  baseUrl: string
  autoApprove: boolean
  /** Bearer token from `loadOrchestratorConfig()`. May be undefined. */
  token: string | undefined
}): Promise<ChunkHandlerResult> {
  const { chunk, runId, baseUrl, autoApprove, token } = args
  const t = chunk.type

  if (t === 'text-delta') {
    // AI SDK shape: { type: 'text-delta', id, delta: string }
    const delta = (chunk as { delta?: string; textDelta?: string }).delta
      ?? (chunk as { delta?: string; textDelta?: string }).textDelta
      ?? ''
    process.stdout.write(delta)
    return { terminal: false }
  }

  if (t === 'reasoning-delta') {
    const delta = (chunk as { delta?: string }).delta ?? ''
    process.stdout.write(`\x1b[2m${delta}\x1b[0m`)
    return { terminal: false }
  }

  // AI SDK v7-beta-111 emits tool-input-* / tool-output-* (renamed from
  // tool-call / tool-result in earlier versions). We forward both shapes
  // for forward-compat — if the SDK rolls the names back, we still render.
  if (t === 'tool-input-available' || t === 'tool-call') {
    const c = chunk as { toolName?: string; input?: unknown; toolCallId?: string }
    const inputStr = JSON.stringify(c.input ?? {}).slice(0, 200)
    console.error(`\n[tool] ${c.toolName ?? '?'}(${inputStr})`)
    return { terminal: false }
  }

  if (t === 'tool-output-available' || t === 'tool-result') {
    const c = chunk as { toolName?: string; output?: unknown }
    const outStr =
      typeof c.output === 'string' ? c.output : JSON.stringify(c.output ?? '')
    console.error(`[tool result] ${outStr.slice(0, 300)}`)
    return { terminal: false }
  }

  if (t === 'data-run-started') {
    const d = (chunk as { data?: Record<string, unknown> }).data ?? {}
    console.error(`[run] started — ${JSON.stringify(d)}`)
    return { terminal: false }
  }

  if (t === 'data-signal-created') {
    const d = (chunk as { data?: SignalCreatedData }).data ?? {}
    const signalId = d.signalId ?? d.signal_id ?? d.signalIdAlt
    if (!signalId) {
      console.error(`[approval] data-signal-created missing signalId; chunk=${JSON.stringify(chunk).slice(0, 300)}`)
      return { terminal: false }
    }
    const cmd = d.command ?? '(no command)'
    const rat = d.rationale ?? '(no rationale)'
    console.error(`\n[approval needed] ${cmd}`)
    console.error(`[approval needed] rationale: ${rat}`)
    console.error(`[approval needed] signalId: ${signalId}`)
    const decision = autoApprove ? 'approve' : await promptApproval()
    console.error(`[approval] ${decision}`)
    const resolveHeaders: Record<string, string> = { 'content-type': 'application/json' }
    if (token) resolveHeaders.authorization = `Bearer ${token}`
    const res = await fetch(`${baseUrl}/api/v1/signals/${signalId}/resolve`, {
      method: 'POST',
      headers: resolveHeaders,
      body: JSON.stringify({ decision }),
    })
    if (!res.ok) {
      console.error(`[approval] resolve failed: ${res.status} ${await safeText(res)}`)
    }
    return { terminal: false }
  }

  if (t === 'data-signal-resolved') {
    const d = (chunk as { data?: { decision?: string } }).data ?? {}
    console.error(`[approval] resolved → ${d.decision ?? '?'}`)
    return { terminal: false }
  }

  if (t === 'data-run-completed') {
    const d = (chunk as { data?: { final_text?: string; turn_count?: number } }).data ?? {}
    if (d.final_text) {
      process.stdout.write('\n')
      console.error(`[run] completed — ${d.turn_count ?? '?'} turns`)
      console.error(`[run] final: ${d.final_text}`)
    }
    return { terminal: true, exitCode: 0 }
  }

  if (t === 'data-run-failed') {
    const d = (chunk as { data?: { error?: string } }).data ?? {}
    console.error(`\n[run] FAILED: ${d.error ?? '(no message)'}`)
    return { terminal: true, exitCode: 1 }
  }

  if (t === 'data-run-cancelled') {
    console.error('\n[run] cancelled')
    return { terminal: true, exitCode: 2 }
  }

  // Lifecycle/meta chunks we don't render: start, start-step, finish, finish-step,
  // text-start, text-end, reasoning-start, reasoning-end, tool-input-start/delta/end
  return { terminal: false }
}

async function promptApproval(): Promise<'approve' | 'reject' | 'skip'> {
  if (!process.stdin.isTTY) {
    // Headless mode without --auto-approve: default to skip so we don't
    // hang. Lets test runners that explicitly disable auto-approve still
    // exit deterministically.
    console.error('[approval] non-TTY without --auto-approve — defaulting to skip')
    return 'skip'
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    while (true) {
      const ans = await new Promise<string>(resolve => {
        rl.question('[a]pprove / [r]eject / [s]kip > ', resolve)
      })
      const t = ans.trim().toLowerCase()
      if (t === 'a' || t === 'approve') return 'approve'
      if (t === 'r' || t === 'reject') return 'reject'
      if (t === 's' || t === 'skip') return 'skip'
      console.error('Enter a, r, or s.')
    }
  } finally {
    rl.close()
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/**
 * Parse SSE bytes into UIMessageChunk JSON objects. Each event is a
 * `data: <JSON>\n\n` block. Multi-line `data:` is concatenated with `\n`
 * per the SSE spec, but AI SDK always emits single-line events so we
 * keep the parser simple.
 */
async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<UIMessageChunk> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Events end with \n\n (or \r\n\r\n)
      let idx: number
      while ((idx = findEventBoundary(buffer)) >= 0) {
        const event = buffer.slice(0, idx)
        buffer = buffer.slice(idx).replace(/^(\r?\n){2}/, '')
        const parsed = parseEvent(event)
        if (parsed) yield parsed
      }
    }
    // Flush any trailing event
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
  // Accumulate consecutive `data:` lines (SSE spec joins them with `\n`)
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
