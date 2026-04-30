/**
 * Minimal HTTP client for the orchestrator's `/api/v1/*` routes. Used by
 * the new `runs`/`signals`/`accounts`/`teams` CLI subcommands.
 *
 * Forwards bearer token from `loadOrchestratorConfig()` automatically.
 * Throws on non-2xx with the response status + body excerpt so the CLI
 * can surface useful errors.
 */
import { loadOrchestratorConfig } from '../config.js'

interface RequestOpts {
  /** Override the resolved orchestrator URL. */
  url?: string
  /** Override the resolved bearer token (rare — mostly for tests). */
  token?: string
  /** Query string params (encoded into URL). */
  query?: Record<string, string | number | undefined>
  /** JSON body (auto-serialized + content-type=application/json). */
  body?: unknown
  /**
   * Pre-serialized text body (no JSON wrap). Use for endpoints that
   * accept text/markdown etc. Ignored if `body` is also set.
   */
  textBody?: string
  /** Override `Content-Type` (auto-set when textBody is present). */
  contentType?: string
  /** Override `Accept` header (default `application/json`). */
  accept?: string
}

interface ApiClient {
  url: string
  get<T = unknown>(path: string, opts?: RequestOpts): Promise<T>
  post<T = unknown>(path: string, opts?: RequestOpts): Promise<T>
  put<T = unknown>(path: string, opts?: RequestOpts): Promise<T>
  del<T = unknown>(path: string, opts?: RequestOpts): Promise<T>
  raw(path: string, opts?: RequestOpts & { method?: string }): Promise<Response>
}

export function makeApiClient(opts: { url?: string; token?: string } = {}): ApiClient {
  const cfg = loadOrchestratorConfig()
  const baseUrl = (opts.url ?? cfg.url).replace(/\/$/, '')
  const token = opts.token ?? cfg.token

  function buildUrl(p: string, query?: RequestOpts['query']): string {
    const path = p.startsWith('/') ? p : `/${p}`
    if (!query) return `${baseUrl}${path}`
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&')
    return qs ? `${baseUrl}${path}?${qs}` : `${baseUrl}${path}`
  }

  function headers(o?: RequestOpts): Record<string, string> {
    const h: Record<string, string> = { accept: o?.accept ?? 'application/json' }
    if (o?.body !== undefined) h['content-type'] = o?.contentType ?? 'application/json'
    else if (o?.textBody !== undefined) h['content-type'] = o?.contentType ?? 'text/plain'
    if (token) h.authorization = `Bearer ${token}`
    return h
  }

  async function raw(path: string, o: RequestOpts & { method?: string } = {}): Promise<Response> {
    const url = buildUrl(path, o.query)
    const init: RequestInit = {
      method: o.method ?? 'GET',
      headers: headers(o),
    }
    if (o.body !== undefined) init.body = JSON.stringify(o.body)
    else if (o.textBody !== undefined) init.body = o.textBody
    return fetch(url, init)
  }

  async function jsonRequest<T>(method: string, path: string, o?: RequestOpts): Promise<T> {
    const res = await raw(path, { ...o, method })
    if (!res.ok) {
      let bodyText = ''
      try { bodyText = (await res.text()).slice(0, 500) } catch { /* ignore */ }
      throw new Error(`${method} ${path} → HTTP ${res.status} ${res.statusText}${bodyText ? `\n  ${bodyText}` : ''}`)
    }
    // Some routes (e.g. PUT env file) return text/plain; fall back gracefully.
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) return (await res.json()) as T
    return (await res.text()) as unknown as T
  }

  return {
    url: baseUrl,
    get: (p, o) => jsonRequest('GET', p, o),
    post: (p, o) => jsonRequest('POST', p, o),
    put: (p, o) => jsonRequest('PUT', p, o),
    del: (p, o) => jsonRequest('DELETE', p, o),
    raw,
  }
}
