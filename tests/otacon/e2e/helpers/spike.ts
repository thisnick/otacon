/**
 * Shared helpers for Pi-spike e2e tests.
 *
 * All `runOtacon` invocations target the spike's CLI on the `pi-spike` branch
 * via `pnpm --filter otacon-spike otacon ...`. Mirrors the style of
 * `tests/orchestrator/e2e/helpers/run-and-tail.ts`.
 *
 * Phone resolution uses the orchestrator package's resolvePhone helper —
 * looks up phone-4's local id from the registry (OTACON_REGISTRY_URL +
 * OTACON_TOKEN env or ~/.otacon/config.toml).
 */
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const REPO_ROOT = path.resolve(__dirname, '../../../..')
export const OTACON_DIR = path.resolve(REPO_ROOT, 'src/otacon')

export const ACCOUNT_ID = 'xhs:test'
export const ACCOUNT_PHONE = process.env.OTACON_SPIKE_WORKSPACE_PHONE ?? '+13412137456'
export const TEAM_NAME = 'social-media-engagement'

export const SPIKE_TIMEOUT_MS = Number(process.env.OTACON_SPIKE_TIMEOUT_MS ?? 25 * 60_000)

// ---------------------------------------------------------------------------
// Per-scenario shared assertion plumbing (copy of the phase1-5 style)
// ---------------------------------------------------------------------------

export interface AssertCounters {
  passed: number
  failed: number
  failures: string[]
}

export function makeCounters(): AssertCounters {
  return { passed: 0, failed: 0, failures: [] }
}

export function assert(c: AssertCounters, cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  PASS  ${msg}`)
    c.passed++
  } else {
    console.log(`  FAIL  ${msg}`)
    c.failures.push(msg)
    c.failed++
  }
}

export function info(msg: string): void {
  console.log(`  INFO  ${msg}`)
}

export function section(title: string): void {
  console.log(`\n--- ${title} ---`)
}

export function summary(name: string, c: AssertCounters): void {
  console.log(`\n=== ${name} summary ===`)
  console.log(`  passed: ${c.passed}`)
  console.log(`  failed: ${c.failed}`)
  if (c.failed > 0) {
    console.log(`\n  failures:`)
    for (const f of c.failures) console.log(`    - ${f}`)
  }
}

export function exitFromCounters(name: string, c: AssertCounters): never {
  if (c.failed > 0) {
    console.log(`\n  ${name}: ${c.failed} assertions failed.`)
    process.exit(1)
  }
  console.log(`\n  ${name}: all ${c.passed} assertions passed.`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Tmp data dir management
// ---------------------------------------------------------------------------

export interface SpikeFixture {
  /** Tmp root dir (parent of `.otacon-data/`) — gets nuked on cleanup. */
  tmpRoot: string
  /** `.otacon-data/` root for this scenario (absolute). */
  dataDir: string
  /** Absolute path to the workspace dir under dataDir. */
  workspaceDir: string
  /** Absolute path to the team-state dir (under workspaceDir/teams/<team>). */
  teamStateDir: string
  /** Absolute path to the team definition dir (under dataDir/teams/<team>). */
  teamDefDir: string
}

export function makeFixture(name: string): SpikeFixture {
  const tmpRoot =
    process.env.OTACON_SPIKE_DATA_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), `otacon-spike-${name}-`))
  const dataDir = path.join(tmpRoot, '.otacon-test-data')
  fs.mkdirSync(dataDir, { recursive: true })
  return {
    tmpRoot,
    dataDir,
    workspaceDir: path.join(dataDir, 'workspaces', ACCOUNT_ID),
    teamStateDir: path.join(dataDir, 'workspaces', ACCOUNT_ID, 'teams', TEAM_NAME),
    teamDefDir: path.join(dataDir, 'teams', TEAM_NAME),
  }
}

export function cleanupFixture(fix: SpikeFixture): void {
  if (process.env.KEEP_TMP_DIR === '1') {
    console.log(`KEEP_TMP_DIR=1 — preserving ${fix.tmpRoot} for manual inspection`)
    return
  }
  if (fs.existsSync(fix.tmpRoot)) {
    fs.rmSync(fix.tmpRoot, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Bootstrap — calls the spike's seed script against fix.dataDir.
// Per task #3 handoff runbook: `pnpm --filter otacon-spike seed` with
// OTACON_DATA_DIR set produces workspace + team + S2 marker file.
// ---------------------------------------------------------------------------

export function seedSpike(fix: SpikeFixture): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('pnpm', ['--filter', 'otacon-spike', 'seed'], {
    cwd: REPO_ROOT,
    env: { ...process.env, OTACON_DATA_DIR: fix.dataDir },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

// ---------------------------------------------------------------------------
// Phone resolver — uses the orchestrator's resolvePhone to look up phone-4's
// local id from the registry and produce the --phone <baseUrl> arg.
// Cached across scenarios so we don't hammer the registry.
// ---------------------------------------------------------------------------

let cachedPhoneBaseUrl: string | null = null

export async function resolvePhoneBaseUrl(
  phoneNumber: string = ACCOUNT_PHONE,
): Promise<string> {
  if (cachedPhoneBaseUrl) return cachedPhoneBaseUrl
  const mod = await import(
    path.resolve(REPO_ROOT, 'src/orchestrator/src/resolve/phone.ts')
  ) as { resolvePhone: (n: string) => Promise<{ baseUrl: string }> }
  const r = await mod.resolvePhone(phoneNumber)
  cachedPhoneBaseUrl = r.baseUrl
  return r.baseUrl
}

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

export interface OtaconRunArgs {
  workspace?: string
  team?: string
  /** Either '--new' / '-s <id>' / nothing (default = last). */
  resume?: 'new' | { sessionId: string } | undefined
  phone?: string
  autoApprove?: boolean
  autoReject?: boolean
  message: string
}

/**
 * Run `otacon run` synchronously against a per-scenario data dir.
 * Stdin is /dev/null. For interactive TTY runs (S4 manual y/n) use
 * `runOtaconWithStdin`.
 */
export function runOtaconRun(
  fix: SpikeFixture,
  args: OtaconRunArgs,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs: number = SPIKE_TIMEOUT_MS,
): RunResult {
  const argv: string[] = [
    '--filter', 'otacon-spike', 'otacon', 'run',
    '-w', args.workspace ?? ACCOUNT_ID,
    '-t', args.team ?? TEAM_NAME,
  ]
  if (args.resume === 'new') argv.push('--new')
  else if (args.resume && typeof args.resume === 'object') argv.push('--session', args.resume.sessionId)
  if (args.phone) argv.push('--phone', args.phone)
  if (args.autoApprove) argv.push('--auto-approve')
  if (args.autoReject) argv.push('--auto-reject')
  argv.push(args.message)

  const res = spawnSync('pnpm', argv, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OTACON_DATA_DIR: fix.dataDir,
      ...extraEnv,
    },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
  })
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

/**
 * Spawn `otacon run` with a piped stdin. Per implementer's contract, the
 * approval gate uses readline on stdin (prompts go to stderr). Caller can
 * pipe `y\n` / `n\n` answers via the `stdinFeed` string.
 */
export function runOtaconWithStdin(
  fix: SpikeFixture,
  args: OtaconRunArgs,
  stdinFeed: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs: number = SPIKE_TIMEOUT_MS,
): Promise<RunResult> {
  const argv: string[] = [
    '--filter', 'otacon-spike', 'otacon', 'run',
    '-w', args.workspace ?? ACCOUNT_ID,
    '-t', args.team ?? TEAM_NAME,
  ]
  if (args.resume === 'new') argv.push('--new')
  else if (args.resume && typeof args.resume === 'object') argv.push('--session', args.resume.sessionId)
  if (args.phone) argv.push('--phone', args.phone)
  if (args.autoApprove) argv.push('--auto-approve')
  if (args.autoReject) argv.push('--auto-reject')
  argv.push(args.message)

  return new Promise<RunResult>(resolve => {
    const proc = spawn('pnpm', argv, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OTACON_DATA_DIR: fix.dataDir,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout!.on('data', chunk => { stdout += chunk.toString('utf-8') })
    proc.stderr!.on('data', chunk => { stderr += chunk.toString('utf-8') })
    proc.stdin!.write(stdinFeed)
    proc.stdin!.end()
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      setTimeout(() => proc.kill('SIGKILL'), 5_000)
    }, timeoutMs)
    proc.on('exit', code => {
      clearTimeout(timer)
      resolve({ status: code ?? 1, stdout, stderr })
    })
  })
}

// ---------------------------------------------------------------------------
// JSONL helpers
// ---------------------------------------------------------------------------

export function countLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0
  const content = fs.readFileSync(filePath, 'utf-8')
  if (content.length === 0) return 0
  return content.split('\n').filter(line => line.length > 0).length
}

export function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return []
  const content = fs.readFileSync(filePath, 'utf-8')
  return content.split('\n').filter(line => line.length > 0)
}

export function readJsonlEvents(filePath: string): Array<Record<string, unknown>> {
  return readLines(filePath).map(line => {
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch {
      return { __parseError: true, raw: line } as Record<string, unknown>
    }
  })
}

// ---------------------------------------------------------------------------
// Path helpers (relative to a fixture)
// ---------------------------------------------------------------------------

export function sessionDirOf(fix: SpikeFixture, sessionId: string): string {
  return path.join(fix.teamStateDir, 'sessions', sessionId)
}

export function lastSessionFileOf(fix: SpikeFixture): string {
  return path.join(fix.teamStateDir, 'last-session.txt')
}

export function readLastSessionId(fix: SpikeFixture): string | null {
  const f = lastSessionFileOf(fix)
  if (!fs.existsSync(f)) return null
  const v = fs.readFileSync(f, 'utf-8').trim()
  return v.length > 0 ? v : null
}

export function listSessionIds(fix: SpikeFixture): string[] {
  const root = path.join(fix.teamStateDir, 'sessions')
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root).sort()
}

// Re-export ChildProcess for type referencing in scenario files if needed.
export type { ChildProcess }
