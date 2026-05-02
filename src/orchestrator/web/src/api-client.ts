// Thin wrapper over fetch + EventSource for the orchestrator HTTP API.
//
// Spec: docs/orchestrator-api.md.

import type {
  ApiError,
  OtaconEvent,
  ResolveEscalationRequest,
  SessionSummary,
  StartRunRequest,
  TeamSummary,
  WorkspaceSummary,
} from './types.js'

declare global {
  interface Window {
    __API_BASE__?: string
  }
}

function resolveApiBase(): string {
  const fromEnv = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''
  const fromWindow = typeof window !== 'undefined' ? window.__API_BASE__ : undefined
  return (fromWindow ?? fromEnv ?? '').replace(/\/$/, '')
}

export const API_BASE = resolveApiBase()

export class ApiClientError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, body: ApiError) {
    super(body.error.message)
    this.status = status
    this.code = body.error.code
    this.details = body.error.details
  }
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({
      error: { code: 'unknown', message: res.statusText },
    }))) as ApiError
    throw new ApiClientError(res.status, body)
  }
  return res.json() as Promise<T>
}

async function* readNdjson(res: Response): AsyncGenerator<unknown> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) yield JSON.parse(line)
      nl = buf.indexOf('\n')
    }
  }
  const tail = buf.trim()
  if (tail) yield JSON.parse(tail)
}

export function listWorkspaces(): Promise<WorkspaceSummary[]> {
  return getJson('/api/v1/workspaces')
}

export function listTeams(workspace: string): Promise<TeamSummary[]> {
  return getJson(`/api/v1/workspaces/${encodeURIComponent(workspace)}/teams`)
}

export function listSessions(
  workspace: string,
  team: string,
): Promise<SessionSummary[]> {
  return getJson(
    `/api/v1/workspaces/${encodeURIComponent(workspace)}/teams/${encodeURIComponent(team)}/sessions`,
  )
}

export function getSession(
  workspace: string,
  team: string,
  sid: string,
): Promise<SessionSummary> {
  return getJson(
    `/api/v1/workspaces/${encodeURIComponent(workspace)}/teams/${encodeURIComponent(team)}/sessions/${encodeURIComponent(sid)}`,
  )
}

// NDJSON GET — full read of events.jsonl for a session.
export async function* getEventsHistory(
  workspace: string,
  team: string,
  sid: string,
): AsyncGenerator<OtaconEvent> {
  const res = await fetch(
    `${API_BASE}/api/v1/workspaces/${encodeURIComponent(workspace)}/teams/${encodeURIComponent(team)}/sessions/${encodeURIComponent(sid)}/events`,
    { headers: { Accept: 'application/x-ndjson' } },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({
      error: { code: 'unknown', message: res.statusText },
    }))) as ApiError
    throw new ApiClientError(res.status, body)
  }
  for await (const line of readNdjson(res)) {
    yield line as OtaconEvent
  }
}

// NDJSON GET — messages.jsonl. Caller decodes the AgentMessage shape.
export async function* getMessages(
  workspace: string,
  team: string,
  sid: string,
): AsyncGenerator<unknown> {
  const res = await fetch(
    `${API_BASE}/api/v1/workspaces/${encodeURIComponent(workspace)}/teams/${encodeURIComponent(team)}/sessions/${encodeURIComponent(sid)}/messages`,
    { headers: { Accept: 'application/x-ndjson' } },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({
      error: { code: 'unknown', message: res.statusText },
    }))) as ApiError
    throw new ApiClientError(res.status, body)
  }
  for await (const line of readNdjson(res)) {
    yield line
  }
}

export interface SseHandle {
  close: () => void
}

interface StreamCallbacks {
  onEvent: (ev: OtaconEvent) => void
  onDone?: () => void
  onError?: (err: Error) => void
}

// Live tail an existing session via SSE replay+tail.
export function streamSessionEvents(
  workspace: string,
  team: string,
  sid: string,
  cb: StreamCallbacks,
): SseHandle {
  const url = `${API_BASE}/api/v1/workspaces/${encodeURIComponent(workspace)}/teams/${encodeURIComponent(team)}/sessions/${encodeURIComponent(sid)}/events`
  return openSse(url, cb)
}

// Start a run. Returns a session id (parsed from response header) AND a live
// SSE handle for the stream of events. Uses fetch+ReadableStream because
// EventSource only supports GET.
export interface StartRunHandle extends SseHandle {
  sessionId: Promise<string>
}

export function startRun(req: StartRunRequest, cb: StreamCallbacks): StartRunHandle {
  const ctrl = new AbortController()
  const sessionIdPromise = (async () => {
    const res = await fetch(`${API_BASE}/api/v1/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({
        error: { code: 'unknown', message: res.statusText },
      }))) as ApiError
      throw new ApiClientError(res.status, body)
    }
    const sessionId = res.headers.get('x-orchestrator-session-id') ?? ''
    void consumeSseStream(res, cb)
    return sessionId
  })()
  sessionIdPromise.catch((err) => {
    if (cb.onError) cb.onError(err instanceof Error ? err : new Error(String(err)))
  })
  return {
    sessionId: sessionIdPromise,
    close: () => ctrl.abort(),
  }
}

async function consumeSseStream(res: Response, cb: StreamCallbacks): Promise<void> {
  if (!res.body) {
    cb.onDone?.()
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let sep = buf.indexOf('\n\n')
      while (sep >= 0) {
        const block = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        const data = parseSseBlock(block)
        if (data === '[DONE]') {
          cb.onDone?.()
          return
        }
        if (data !== null) {
          try {
            cb.onEvent(JSON.parse(data) as OtaconEvent)
          } catch (err) {
            cb.onError?.(err instanceof Error ? err : new Error(String(err)))
          }
        }
        sep = buf.indexOf('\n\n')
      }
    }
    cb.onDone?.()
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') return
    cb.onError?.(err instanceof Error ? err : new Error(String(err)))
  }
}

function parseSseBlock(block: string): string | null {
  // Concatenate all `data: ` lines per the SSE spec.
  const lines = block.split('\n')
  const data: string[] = []
  for (const line of lines) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (data.length === 0) return null
  return data.join('\n')
}

function openSse(url: string, cb: StreamCallbacks): SseHandle {
  const ctrl = new AbortController()
  void (async () => {
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: ctrl.signal,
    }).catch((err) => {
      cb.onError?.(err instanceof Error ? err : new Error(String(err)))
      return null
    })
    if (!res) return
    if (!res.ok) {
      cb.onError?.(new Error(`SSE failed: HTTP ${res.status}`))
      return
    }
    await consumeSseStream(res, cb)
  })()
  return { close: () => ctrl.abort() }
}

export async function resolveEscalation(
  token: string,
  body: ResolveEscalationRequest,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/v1/escalations/${encodeURIComponent(token)}/resolve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({
      error: { code: 'unknown', message: res.statusText },
    }))) as ApiError
    throw new ApiClientError(res.status, errBody)
  }
}

// Build an API URL for a trace screenshot. The server emits filesystem paths
// (relative to ORCHESTRATOR_DATA_DIR) that always contain the substring
//   workspaces/<ws>/teams/<team>/sessions/<sid>/traces/<tcid>/<file>
// We locate that prefix and reconstruct as `/api/v1/<same>`. Each segment
// is URL-encoded so workspace ids with colons survive.
export function traceUrl(fsPath: string | null): string | null {
  if (!fsPath) return null
  const idx = fsPath.indexOf('workspaces/')
  if (idx < 0) return null
  const segments = fsPath
    .slice(idx)
    .split('/')
    .map((s) => encodeURIComponent(s))
  return `${API_BASE}/api/v1/${segments.join('/')}`
}
