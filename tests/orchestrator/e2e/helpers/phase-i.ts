/**
 * Helpers for Phase I server-side e2e tests.
 *
 * Phase I tests run against a local orchestrator server booted into a
 * tmpdir data root. This isolates each scenario from real fleet data and
 * makes the suite hermetic — no VPS round-trip, no network dependency
 * (except I5 which exercises the registry proxy intentionally).
 *
 * The local server is launched as a child process via the compiled
 * `dist/src/server/start.js` entry point, with a per-scenario port and
 * data dir. The helper waits for `/healthz` to come back 200 before
 * yielding.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const REPO_ROOT = path.resolve(__dirname, '../../../..')
export const ORCHESTRATOR_DIR = path.resolve(REPO_ROOT, 'src/orchestrator')

export interface LocalServer {
  port: number
  dataRoot: string
  baseUrl: string
  proc: ChildProcess
  stop: () => Promise<void>
}

/** Pick a port in the high range. Random enough to parallelize 7 scenarios. */
function pickPort(): number {
  return 19000 + Math.floor(Math.random() * 1000)
}

export interface BootOpts {
  /** When true, runs the seed script before booting (creates default team). */
  seed?: boolean
  /** When true, prints server stderr to this process's stderr. */
  verbose?: boolean
  /** Override env vars passed to the child process. */
  env?: Record<string, string | undefined>
}

/**
 * Boot a local orchestrator server with a fresh temp data root. Returns
 * a handle with `baseUrl` for HTTP calls and `stop()` to terminate.
 *
 * Caller MUST `await stop()` to release the port and clean up the data
 * dir. Tests use `try { ... } finally { await server.stop() }`.
 */
export async function bootLocalServer(opts: BootOpts = {}): Promise<LocalServer> {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otacon-phase-i-'))
  const port = pickPort()
  const baseUrl = `http://127.0.0.1:${port}`

  const startScript = path.resolve(ORCHESTRATOR_DIR, 'dist/src/server/start.js')
  if (!fs.existsSync(startScript)) {
    throw new Error(
      `Compiled server entry not found at ${startScript}. ` +
      `Run \`pnpm --filter orchestrator build\` first.`,
    )
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ORCHESTRATOR_DATA_DIR: dataRoot,
    PORT: String(port),
    HOST: '127.0.0.1',
    ...(opts.env ?? {}),
  }

  if (opts.seed) {
    const seedScript = path.resolve(ORCHESTRATOR_DIR, 'dist/scripts/seed.js')
    if (!fs.existsSync(seedScript)) {
      throw new Error(`Seed script not built at ${seedScript}`)
    }
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync('node', [seedScript], { env, encoding: 'utf-8' })
    if (r.status !== 0) {
      throw new Error(`seed failed: ${r.stderr || r.stdout}`)
    }
  }

  const proc = spawn('node', [startScript], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (opts.verbose) {
    proc.stderr?.on('data', d => process.stderr.write(`[server] ${d}`))
    proc.stdout?.on('data', d => process.stderr.write(`[server-out] ${d}`))
  }

  // Wait for health up to 10s.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/healthz`)
      if (r.ok) {
        const body = await r.json() as { ok?: boolean }
        if (body.ok === true) {
          return {
            port,
            dataRoot,
            baseUrl,
            proc,
            stop: async () => {
              proc.kill('SIGTERM')
              await new Promise<void>(resolve => {
                if (proc.exitCode !== null) return resolve()
                proc.once('exit', () => resolve())
                setTimeout(() => { try { proc.kill('SIGKILL') } catch {}; resolve() }, 2_000)
              })
              try { fs.rmSync(dataRoot, { recursive: true, force: true }) } catch {}
            },
          }
        }
      }
    } catch {
      // server not ready yet
    }
    await new Promise(r => setTimeout(r, 100))
  }
  proc.kill('SIGKILL')
  try { fs.rmSync(dataRoot, { recursive: true, force: true }) } catch {}
  throw new Error(`server failed to come up at ${baseUrl} within 10s`)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export interface FetchResult<T = unknown> {
  status: number
  ok: boolean
  body: T
  raw: string
  contentType: string | null
}

export async function api<T = unknown>(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
): Promise<FetchResult<T>> {
  const url = `${baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
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

export async function apiText(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
): Promise<{ status: number; ok: boolean; raw: string; contentType: string | null }> {
  const url = `${baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
  const res = await fetch(url, init)
  return {
    status: res.status,
    ok: res.ok,
    raw: await res.text(),
    contentType: res.headers.get('content-type'),
  }
}

/** Verify the response is the canonical `{error: {code, message, details?}}`. */
export function isErrorEnvelope(
  body: unknown,
  expectedCode: string,
): { ok: boolean; reason?: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'not an object' }
  const err = (body as { error?: unknown }).error
  if (typeof err !== 'object' || err === null) return { ok: false, reason: 'no error key' }
  const e = err as Record<string, unknown>
  if (typeof e['code'] !== 'string') return { ok: false, reason: 'code not string' }
  if (typeof e['message'] !== 'string') return { ok: false, reason: 'message not string' }
  if (e['code'] !== expectedCode) {
    return { ok: false, reason: `code=${String(e['code'])} expected ${expectedCode}` }
  }
  return { ok: true }
}
