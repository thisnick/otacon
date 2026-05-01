/**
 * Shared helpers for Pi-spike e2e tests.
 *
 * STATUS: SKELETON — pending implementer (#3) handoff. All `runOtacon`
 * invocations target `pnpm otacon` against the `src/otacon/` tree on the
 * `pi-spike` branch. The exact command shape (`otacon run`, `otacon sessions
 * list`) is per task #3's CLI design; if implementer ships a different shape,
 * the evaluator files observed-vs-expected in TaskUpdate.
 *
 * Mirrors the style of `tests/orchestrator/e2e/helpers/run-and-tail.ts` so
 * Pi-spike scenarios read like phase 1-5.
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

// ---------------------------------------------------------------------------
// Skeleton-exit semantics
// ---------------------------------------------------------------------------

/**
 * Each stub scenario calls this at the end. With assertions stubbed and no
 * failures, exit 2 to flag "skeleton not yet wired" — matches the phase6
 * convention. `OTACON_SPIKE_ALLOW_SKELETON_EXIT=1` silences this and exits 0.
 *
 * Once the scenario has real assertions and they pass, this exit gate is
 * removed in the same commit that wires the assertions.
 */
export function skeletonExit(name: string, c: AssertCounters): never {
  if (c.failed > 0) {
    console.log(`\n  SKELETON FAILURE — ${c.failed} assertions failed in ${name}`)
    process.exit(1)
  }
  if (process.env.OTACON_SPIKE_ALLOW_SKELETON_EXIT === '1') {
    console.log(`  OTACON_SPIKE_ALLOW_SKELETON_EXIT=1 — exiting 0 despite stubs`)
    process.exit(0)
  }
  console.log(`\n  NOTE: ${name} is a SKELETON. Assertions stubbed pending #3 handoff.`)
  console.log(`  Set OTACON_SPIKE_ALLOW_SKELETON_EXIT=1 to silence and exit 0.`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Tmp data dir management
// ---------------------------------------------------------------------------

export interface SpikeFixture {
  /** `.otacon-data/` root for this scenario. */
  dataDir: string
  /** Absolute path to the workspace dir under dataDir. */
  workspaceDir: string
  /** Absolute path to the team-state dir under workspaceDir. */
  teamStateDir: string
  /** Absolute path to the team definition dir under dataDir. */
  teamDefDir: string
}

export function makeFixture(name: string): SpikeFixture {
  const tmpRoot =
    process.env.OTACON_SPIKE_DATA_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), `otacon-spike-${name}-`))
  // .otacon-data/ lives inside the tmpRoot so cleanup is one rm.
  const dataDir = path.join(tmpRoot, '.otacon-data')
  fs.mkdirSync(dataDir, { recursive: true })
  return {
    dataDir,
    workspaceDir: path.join(dataDir, 'workspaces', ACCOUNT_ID),
    teamStateDir: path.join(dataDir, 'workspaces', ACCOUNT_ID, 'teams', TEAM_NAME),
    teamDefDir: path.join(dataDir, 'teams', TEAM_NAME),
  }
}

export function cleanupFixture(fix: SpikeFixture): void {
  if (process.env.KEEP_TMP_DIR === '1') {
    console.log(`KEEP_TMP_DIR=1 — preserving ${fix.dataDir} for manual inspection`)
    return
  }
  // We delete the parent of dataDir (the mkdtemp dir) so we don't leave the
  // mkdtemp shell behind.
  const tmpRoot = path.dirname(fix.dataDir)
  if (fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// CLI invocation — per task #3 the CLI is `otacon run ...`. The package
// surface (workspace path, package.json bin name) is per implementer's
// commit; this helper takes the cmdline as-is and runs it under
// `pnpm otacon` (or whatever `pnpm` script the implementer wires up). If
// they ship a different invocation surface, evaluator files
// observed-vs-expected.
// ---------------------------------------------------------------------------

export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * Run a synchronous `otacon` CLI command against a per-scenario data dir.
 * For interactive scenarios (S4 — TTY approval prompt), use `runOtaconInteractive`.
 */
export function runOtacon(
  args: string[],
  dataDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): RunResult {
  const res = spawnSync('pnpm', ['otacon', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OTACON_DATA_DIR: dataDir,
      ...extraEnv,
    },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

/**
 * Spawn `otacon` with stdin available — used by S4 to drive the TTY approval
 * prompt. Caller writes `y\n` or `n\n` to `proc.stdin` and consumes stdout.
 *
 * NOTE: Pi's TTY approval gate (per task #3 design) reads via readline. If
 * the implementer's prompt requires a real PTY (not a piped stdin), the
 * scenario must use `node-pty` instead — that's a feedback item for #3
 * if `process.stdin` from a piped stdio is rejected by Pi's gate.
 */
export function runOtaconInteractive(
  args: string[],
  dataDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): ChildProcess {
  return spawn('pnpm', ['otacon', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OTACON_DATA_DIR: dataDir,
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

// ---------------------------------------------------------------------------
// Bootstrap helpers — populate the `.otacon-data/` tree per task #3 layout.
// Implementer (#3) ships a `bootstrap` script or seed CLI; we DEFER calling
// theirs in skeleton-mode and just stub a TODO. Real assertions wire to
// whatever the implementer surfaces at handoff (probably `otacon workspace
// init xhs:test` + `otacon team init social-media-engagement` or a one-shot
// `pnpm tsx scripts/bootstrap-spike.ts`).
// ---------------------------------------------------------------------------

export function bootstrapTODO(fix: SpikeFixture): void {
  info(`(stub) bootstrap pending implementer handoff. Need:`)
  info(`  ${fix.workspaceDir}/workspace.json`)
  info(`  ${fix.workspaceDir}/credentials.json`)
  info(`  ${fix.workspaceDir}/env/{persona.md,soul.md,agents.md}`)
  info(`  ${fix.workspaceDir}/memory/  (empty dir)`)
  info(`  ${fix.teamDefDir}/team.json`)
  info(`  ${fix.teamDefDir}/prompts/{lead.md,tools.md}`)
}

// ---------------------------------------------------------------------------
// JSONL line-count helper — used by S2/S3 to assert append vs replace.
// ---------------------------------------------------------------------------

export function countLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0
  const content = fs.readFileSync(filePath, 'utf-8')
  if (content.length === 0) return 0
  // Trailing newline doesn't count as an entry.
  return content.split('\n').filter(line => line.length > 0).length
}

export function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return []
  const content = fs.readFileSync(filePath, 'utf-8')
  return content.split('\n').filter(line => line.length > 0)
}
