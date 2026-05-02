/**
 * Phase G helpers — UI hosted same-origin by the API server.
 *
 * Phase G replaces `orchestrator ui --api <url>` (Phase F's flow) with a
 * server-hosted UI at `/`. The CLI `orchestrator ui` is now a local-only
 * convenience launcher: it always proxies to `http://localhost:9090` and
 * has NO `--api` flag.
 *
 * Helpers here are minimal; most of the heavy lifting is reused from
 * `helpers/phase-f.ts` (HTTP, SSE, ssh, fixture, etc.). Phase G adds:
 *   - `startLocalUiNoApi()` — spawn `orchestrator ui` without `--api`
 *   - `tryLocalUiWithApi()` — spawn `orchestrator ui --api X` and assert
 *     it FAILS (G5 regression check)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
export const REPO_ROOT = path.resolve(__dirname, '../../../..')

// ---------------------------------------------------------------------------
// `orchestrator ui` (local mode, no --api flag) — Phase G's simplified launcher
// ---------------------------------------------------------------------------

export interface LocalUiNoApiHandle {
  proc: ChildProcess
  port: number
  url: string
  /** Captured stdout — useful for assertions on the printed banner. */
  stdoutBuf: () => string
  close: () => Promise<void>
}

/**
 * Spawn `pnpm --filter orchestrator orchestrator ui --no-open` (no --api).
 * Parses the local URL out of stdout, then waits for the server to accept
 * connections. Throws on timeout. Caller is responsible for closing.
 */
export async function startLocalUiNoApi(port?: number): Promise<LocalUiNoApiHandle> {
  const args = ['--filter', 'orchestrator', 'orchestrator', 'ui', '--no-open']
  if (port !== undefined) args.push('--port', String(port))
  const proc = spawn('pnpm', args, {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdoutBuf = ''
  let stderrBuf = ''
  proc.stdout!.on('data', chunk => { stdoutBuf += chunk.toString('utf-8') })
  proc.stderr!.on('data', chunk => { stderrBuf += chunk.toString('utf-8') })

  // The launcher prints `local: http://localhost:NNNN` shortly after listen.
  const url = await new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + 15_000
    const tick = () => {
      const m = stdoutBuf.match(/local:\s+(http:\/\/localhost:(\d+))/)
      if (m) return resolve(m[1]!)
      if (proc.exitCode !== null) {
        return reject(new Error(
          `ui exited (code ${proc.exitCode}) before printing local URL. ` +
          `stdout: ${stdoutBuf.slice(0, 600)} stderr: ${stderrBuf.slice(0, 600)}`,
        ))
      }
      if (Date.now() > deadline) {
        return reject(new Error(
          `ui didn't print local URL in 15s. ` +
          `stdout: ${stdoutBuf.slice(0, 600)} stderr: ${stderrBuf.slice(0, 600)}`,
        ))
      }
      setTimeout(tick, 200)
    }
    tick()
  })
  const portNum = Number(url.match(/:(\d+)$/)![1])

  // Wait for server to actually accept connections. The proxy forwards to
  // localhost:9090 — that may or may not be listening here, but the static
  // path / always works once the listen() resolved.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5_000
    const probe = async () => {
      while (Date.now() < deadline) {
        try {
          const r = await fetch(url + '/')
          if (r.status === 200) { resolve(); return }
        } catch {}
        await new Promise(r => setTimeout(r, 100))
      }
      reject(new Error(`ui server at ${url} didn't accept connections`))
    }
    probe()
  })

  return {
    proc,
    port: portNum,
    url,
    stdoutBuf: () => stdoutBuf,
    close: async () => {
      proc.kill('SIGTERM')
      await new Promise<void>(r => setTimeout(r, 300))
      if (!proc.killed) proc.kill('SIGKILL')
    },
  }
}

// ---------------------------------------------------------------------------
// `orchestrator ui --api X` — Phase G regression check (G5).
// ---------------------------------------------------------------------------

export interface UiWithApiResult {
  exitCode: number
  /** True if the process did NOT silently succeed (G5's pass condition). */
  rejected: boolean
  stdout: string
  stderr: string
}

/**
 * Try `orchestrator ui --api <url> --no-open` and capture exit + output.
 * G5 expectation: the run must NOT silently succeed. Either:
 *   - exitCode !== 0  (commander's "unknown option" exit)
 *   - OR the stderr/stdout contains a clear error/deprecation message
 *
 * Either way, the resulting process must NOT remain running indefinitely.
 * We give it 8s; if still alive after that, we kill it and report the
 * fact (which the caller treats as FAIL — long-running means it accepted
 * the flag, which is the regression we're guarding against).
 */
export function tryLocalUiWithApi(apiArg: string, timeoutMs = 8_000): Promise<UiWithApiResult> {
  return new Promise(resolve => {
    const args = ['--filter', 'orchestrator', 'orchestrator', 'ui', '--api', apiArg, '--no-open']
    const proc = spawn('pnpm', args, {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout!.on('data', chunk => { stdout += chunk.toString('utf-8') })
    proc.stderr!.on('data', chunk => { stderr += chunk.toString('utf-8') })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
      setTimeout(() => proc.kill('SIGKILL'), 1_000)
    }, timeoutMs)

    proc.on('exit', code => {
      clearTimeout(timer)
      const exitCode = code ?? -1
      // Reject (i.e. G5 PASS) if either:
      //  (a) non-zero exit
      //  (b) stderr/stdout has an error word that suggests --api was rejected
      // Process surviving past timeout = treated as accepted (FAIL).
      const errLike = /\berror\b|unknown option|unrecognized|invalid option|no such option|deprecat/i
      const hasErrorMsg = errLike.test(stderr) || errLike.test(stdout)
      const rejected = !timedOut && (exitCode !== 0 || hasErrorMsg)
      resolve({ exitCode, rejected, stdout, stderr })
    })
  })
}

// ---------------------------------------------------------------------------
// `orchestrator ui` exit code from a stripped-down spawnSync — useful for
// G4 negative path (no local serve running, ui should still start the
// proxy fine even if upstream :9090 is dead, since `/` is static).
// ---------------------------------------------------------------------------

export function spawnSyncQuick(argv: string[], timeoutMs = 30_000) {
  return spawnSync('pnpm', ['--filter', 'orchestrator', 'orchestrator', ...argv], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
