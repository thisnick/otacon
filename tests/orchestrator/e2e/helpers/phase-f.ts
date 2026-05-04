/**
 * Helpers for Phase F canary scenarios that target the deployed orchestrator
 * VPS at https://otacon-orchestrator.tail0437b8.ts.net (canonical no-port URL,
 * via Tailscale Serve at :443 → localhost:9090 on the VPS).
 *
 * The base URL is overridable via $ORCHESTRATOR_API_URL for local-serve mode.
 *
 * Phase F scripts are NOT a generic test framework — they intentionally hard-
 * code the seeded `xhs:test` workspace + `social-media-engagement` team so the
 * VPS data they read is the post-seed canonical state.
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

import { ACCOUNT_ID, TEAM_NAME } from './spike.js'

export const VPS_API_BASE =
  process.env.ORCHESTRATOR_API_URL?.replace(/\/+$/, '') ??
  'https://otacon-orchestrator.tail0437b8.ts.net'

export const VPS_SSH_HOST =
  process.env.ORCHESTRATOR_VPS_SSH ?? 'ubuntu@otacon-orchestrator.tail0437b8.ts.net'

/** Encoded path component for `xhs:test`. */
export const ACCOUNT_ID_ENC = encodeURIComponent(ACCOUNT_ID)

export interface FetchResult<T = unknown> {
  status: number
  ok: boolean
  body: T
  raw: string
  contentType: string | null
}

/**
 * Tiny fetch wrapper. Parses JSON when content-type says so.
 */
export async function api<T = unknown>(
  pathname: string,
  init: RequestInit = {},
): Promise<FetchResult<T>> {
  const url = `${VPS_API_BASE}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
  const res = await fetch(url, init)
  const contentType = res.headers.get('content-type')
  const raw = await res.text()
  let body: unknown = raw
  if (contentType?.includes('application/json')) {
    try {
      body = JSON.parse(raw) as unknown
    } catch {
      // keep raw
    }
  }
  return {
    status: res.status,
    ok: res.ok,
    body: body as T,
    raw,
    contentType,
  }
}

/** Resolve phone-4's host base URL via the orchestrator's internal resolver. */
let cachedPhoneBaseUrl: string | null = null
export async function resolvePhoneBaseUrlPhaseF(
  phoneNumber: string = process.env.OTACON_SPIKE_WORKSPACE_PHONE ?? '+13412137456',
): Promise<string> {
  if (cachedPhoneBaseUrl) return cachedPhoneBaseUrl
  const repoRoot = path.resolve(new URL(import.meta.url).pathname, '../../../../..')
  const mod = (await import(
    path.resolve(repoRoot, 'src/orchestrator/src/resolve/phone.ts')
  )) as { resolvePhone: (n: string) => Promise<{ baseUrl: string }> }
  const r = await mod.resolvePhone(phoneNumber)
  cachedPhoneBaseUrl = r.baseUrl
  return r.baseUrl
}

// ---------------------------------------------------------------------------
// SSE consumer for POST /api/v1/runs
// ---------------------------------------------------------------------------

export interface SseConsumeOpts {
  /** Hard timeout (ms) for the whole stream including the agent run. */
  timeoutMs?: number
  /** If true, log each event line as it arrives (very chatty). */
  verbose?: boolean
}

export interface SseEvent {
  data: string
  /** Parsed payload if `data` is JSON, else null. */
  payload: Record<string, unknown> | null
}

export interface SseRunResult {
  sessionId: string | null
  events: SseEvent[]
  /** Convenience: the final pi event (agent_end / agent_error) if reached. */
  terminal: SseEvent | null
  /** True if `data: [DONE]` sentinel was observed. */
  doneSentinel: boolean
  httpStatus: number
}

/**
 * POST /api/v1/runs and consume the SSE stream until `[DONE]` or terminal pi event.
 *
 * Returns the collected events plus the session id from the
 * `x-orchestrator-session-id` response header (per the API spec).
 */
export async function postRunAndConsume(
  body: {
    workspace: string
    team: string
    /**
     * Phase I migration: the server now resolves the phone from the
     * workspace's `phoneNumber` field via the registry. This field is
     * accepted by the helper for back-compat with older test scripts
     * but the server ignores it.
     */
    phone?: string
    userMessage: string
    resume?: 'last' | 'new' | string
    autoApprove?: boolean
    autoReject?: boolean
    modelProvider?: string
  },
  opts: SseConsumeOpts = {},
): Promise<SseRunResult> {
  const timeoutMs = opts.timeoutMs ?? 25 * 60_000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  const res = await fetch(`${VPS_API_BASE}/api/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  })

  const sessionId = res.headers.get('x-orchestrator-session-id')

  if (!res.ok || !res.body) {
    clearTimeout(timer)
    const raw = res.body ? await res.text() : ''
    return {
      sessionId,
      events: [],
      terminal: null,
      doneSentinel: false,
      httpStatus: res.status,
    }
  }

  const events: SseEvent[] = []
  let terminal: SseEvent | null = null
  let doneSentinel = false

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // SSE event boundary = \n\n
      let idx: number
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        // each chunk may contain multiple `data: ...` lines. We expect one.
        const dataLines = chunk
          .split('\n')
          .filter(l => l.startsWith('data: '))
          .map(l => l.slice('data: '.length))
        const data = dataLines.join('\n')
        if (data === '[DONE]') {
          doneSentinel = true
          break
        }
        let payload: Record<string, unknown> | null = null
        try {
          payload = JSON.parse(data) as Record<string, unknown>
        } catch {
          payload = null
        }
        const ev: SseEvent = { data, payload }
        events.push(ev)
        if (opts.verbose) {
          console.log(`  [sse] ${data.slice(0, 200)}${data.length > 200 ? '…' : ''}`)
        }
        if (payload && payload['kind'] === 'pi') {
          const inner = payload['event'] as Record<string, unknown> | undefined
          const t = inner?.['type']
          if (t === 'agent_end' || t === 'agent_error') {
            terminal = ev
          }
        }
      }
      if (doneSentinel) break
    }
  } finally {
    clearTimeout(timer)
    try { reader.releaseLock() } catch {}
  }

  return {
    sessionId,
    events,
    terminal,
    doneSentinel,
    httpStatus: res.status,
  }
}

// ---------------------------------------------------------------------------
// SSH wrapper for log-grep + docker-exec checks against the deployed VPS
// ---------------------------------------------------------------------------

export interface SshResult {
  status: number
  stdout: string
  stderr: string
}

export function ssh(remoteCommand: string, timeoutMs = 60_000): SshResult {
  const res = spawnSync('ssh', [VPS_SSH_HOST, remoteCommand], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 25 * 1024 * 1024,
  })
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

// ---------------------------------------------------------------------------
// Phone-action / event helpers
// ---------------------------------------------------------------------------

export interface PhoneActionEvent {
  toolCallId: string
  command: string
  subcommand: string
  screenshots: { before: string | null; annotated: string | null; after: string | null }
}

export function extractPhoneActions(events: SseEvent[]): PhoneActionEvent[] {
  const out: PhoneActionEvent[] = []
  for (const e of events) {
    if (e.payload && e.payload['kind'] === 'phone_action') {
      const p = e.payload['payload'] as Record<string, unknown> | undefined
      if (!p) continue
      out.push({
        toolCallId: String(p['toolCallId'] ?? ''),
        command: String(p['command'] ?? ''),
        subcommand: String(p['subcommand'] ?? ''),
        screenshots: (p['screenshots'] as PhoneActionEvent['screenshots']) ?? {
          before: null,
          annotated: null,
          after: null,
        },
      })
    }
  }
  return out
}

export function countTurns(events: SseEvent[]): number {
  let n = 0
  for (const e of events) {
    if (e.payload && e.payload['kind'] === 'pi') {
      const inner = e.payload['event'] as Record<string, unknown> | undefined
      if (inner?.['type'] === 'turn_end') n++
    }
  }
  return n
}

export function extractFinalText(events: SseEvent[]): string {
  // The pi-agent-core stream wraps text content inside `message_update`
  // events whose `assistantMessageEvent.type` discriminates between
  // `text_start` / `text_delta` / `text_end` / `toolcall_start` / etc.
  // We stitch together the text by looking at the final partial assistant
  // message at message_end / message_update of the last assistant message.
  // Cheapest reliable approach: walk message_update events in order, find
  // the most recent one whose partial.content[*].type === 'text', and
  // return its accumulated text.
  let lastText = ''
  for (const e of events) {
    if (e.payload && e.payload['kind'] === 'pi') {
      const inner = e.payload['event'] as Record<string, unknown> | undefined
      if (inner?.['type'] !== 'message_update') continue
      const ame = inner['assistantMessageEvent'] as Record<string, unknown> | undefined
      const partial = ame?.['partial'] as Record<string, unknown> | undefined
      const content = partial?.['content'] as Array<Record<string, unknown>> | undefined
      if (!content) continue
      for (const c of content) {
        if (c['type'] === 'text' && typeof c['text'] === 'string') {
          lastText = c['text']
        }
      }
    }
  }
  return lastText.trim()
}

/**
 * Extract the inner `assistantMessageEvent.type` discriminators from the
 * pi-event stream. These are the v7 chunk types that get nested inside
 * `message_update` events (e.g. `text_start`, `text_delta`, `text_end`,
 * `toolcall_start`, `toolcall_delta`, `toolcall_end`).
 */
export function extractInnerEventTypes(events: SseEvent[]): Set<string> {
  const out = new Set<string>()
  for (const e of events) {
    if (e.payload && e.payload['kind'] === 'pi') {
      const inner = e.payload['event'] as Record<string, unknown> | undefined
      if (inner?.['type'] !== 'message_update') continue
      const ame = inner['assistantMessageEvent'] as Record<string, unknown> | undefined
      if (ame && typeof ame['type'] === 'string') out.add(ame['type'])
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Trace URL builder (for F7 sha256-differs check)
// ---------------------------------------------------------------------------

export function traceUrl(
  workspaceId: string,
  team: string,
  sid: string,
  tcid: string,
  file: 'before.png' | 'annotated.png' | 'after.png' | 'result.json',
): string {
  return `${VPS_API_BASE}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(team)}/sessions/${encodeURIComponent(sid)}/traces/${encodeURIComponent(tcid)}/${file}`
}

export async function fetchBytes(url: string): Promise<{ status: number; bytes: Uint8Array; contentType: string | null }> {
  const r = await fetch(url)
  const buf = new Uint8Array(await r.arrayBuffer())
  return { status: r.status, bytes: buf, contentType: r.headers.get('content-type') }
}

import * as crypto from 'node:crypto'

export function sha256Bytes(b: Uint8Array): string {
  return crypto.createHash('sha256').update(b).digest('hex')
}

// ---------------------------------------------------------------------------
// Re-exports for ergonomic import in scenarios
// ---------------------------------------------------------------------------

export { ACCOUNT_ID, TEAM_NAME }
