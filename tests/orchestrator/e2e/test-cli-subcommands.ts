/**
 * E2E test for the new HTTP-backed CLI subcommands (P3-I commit 7):
 *
 *   runs list / show / prompt / messages / cancel / message
 *   signals list / resolve
 *   accounts list / add / show / env get / put / delete
 *   teams list / show
 *
 * Pre-populates a tmp data dir with one team + one account + one run,
 * spawns the server, then invokes each subcommand via `pnpm orchestrator
 * <args>` and asserts the stdout is non-empty + exit 0 (plus a few
 * spot-checks on output content). No phone, no LLM.
 *
 * Run: pnpm test:e2e:cli-subcommands
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnServer, type SpawnedServer } from './helpers/run-and-tail.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ORCH_DIR = path.resolve(__dirname, '../../../src/orchestrator')

const PORT = process.env.CLI_SUBS_PORT ?? '9091'
const BASE_URL = `http://localhost:${PORT}`
const ACCOUNT_ID = 'cli-test:alice'
const TEAM_NAME = 'social-media-engagement'
const RUN_ID = '01KQEZ0000000000000000RUN5'

let passed = 0
let failed = 0

function assert(cond: unknown, msg: string): void {
  if (cond) { console.log(`  PASS  ${msg}`); passed++ }
  else { console.log(`  FAIL  ${msg}`); failed++ }
}

interface CliResult { code: number; stdout: string; stderr: string }

function cli(args: string[]): CliResult {
  // Direct node invocation — `pnpm orchestrator` prepends a banner that
  // breaks JSON parsing.
  const res = spawnSync(
    'node',
    ['--no-warnings', '--import', 'tsx/esm', path.join(ORCH_DIR, 'src/index.ts'), ...args],
    {
      cwd: ORCH_DIR,
      env: { ...process.env, ORCHESTRATOR_URL: BASE_URL, ORCHESTRATOR_DATA_DIR: ctx.tmpDir },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

interface Ctx { tmpDir: string; server: SpawnedServer | null }
const ctx: Ctx = { tmpDir: '', server: null }

function writeRunFixture(dir: string, runId: string, status: string): void {
  const runDir = path.join(dir, 'runs', runId)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
    id: runId,
    account: ACCOUNT_ID,
    team: TEAM_NAME,
    agentRole: 'engagement-lead',
    model: 'alibaba/qwen3.6-plus',
    status,
    startedAt: Date.now() - 30_000,
    completedAt: status === 'completed' ? Date.now() : null,
    workflowRunId: null,
    promptTemplatePaths: [],
    promptSnapshotPath: null,
    initialPrompt: null,
    finalText: status === 'completed' ? 'all done' : null,
    error: null,
    turnCount: status === 'completed' ? 5 : 0,
  }, null, 2))
  fs.writeFileSync(path.join(runDir, 'prompt.md'), '# system prompt\nYou are a helpful agent.\n')
  // The IndexStore reads from main index/runs.jsonl when no filter is
  // active, but from index/by-account/<id>.jsonl or
  // index/by-status/<s>.jsonl when those query filters are present.
  // Mirror writes across all three so test queries see the fixture
  // regardless of filter path.
  const startedAt = Date.now() - 30_000
  const entry = JSON.stringify({ id: runId, account: ACCOUNT_ID, team: TEAM_NAME, status, startedAt }) + '\n'
  fs.mkdirSync(path.join(dir, 'index'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'index', 'by-account'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'index', 'by-status'), { recursive: true })
  fs.appendFileSync(path.join(dir, 'index', 'runs.jsonl'), entry)
  fs.appendFileSync(path.join(dir, 'index', 'by-account', `${ACCOUNT_ID}.jsonl`), entry)
  fs.appendFileSync(path.join(dir, 'index', 'by-status', `${status}.jsonl`), entry)
}

function writeTeamFixture(dir: string, teamName: string): void {
  const teamDir = path.join(dir, 'teams', teamName)
  fs.mkdirSync(path.join(teamDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(teamDir, 'team.json'), JSON.stringify({
    name: teamName,
    lead: 'engagement-lead',
    agents: { 'engagement-lead': { promptPath: 'prompts/engagement-lead.md' } },
  }, null, 2))
  fs.writeFileSync(path.join(teamDir, 'prompts/engagement-lead.md'), '# Lead\n')
}

function writeAccountFixture(dir: string, accountId: string): void {
  const accountDir = path.join(dir, 'accounts', accountId)
  fs.mkdirSync(path.join(accountDir, 'env'), { recursive: true })
  fs.mkdirSync(path.join(accountDir, 'workspace'), { recursive: true })
  fs.writeFileSync(path.join(accountDir, 'account.json'), JSON.stringify({
    id: accountId,
    displayName: 'Alice (CLI test)',
    accountType: 'xhs',
    status: 'active',
    config: {},
    createdAt: Date.now(),
  }, null, 2))
  fs.writeFileSync(path.join(accountDir, 'credentials.json'), JSON.stringify({ rows: [] }, null, 2))
}

async function setup(): Promise<void> {
  ctx.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cli-subs-'))
  console.log('\n=== cli-subcommands e2e ===')
  console.log(`tmpDir = ${ctx.tmpDir}`)
  writeTeamFixture(ctx.tmpDir, TEAM_NAME)
  writeAccountFixture(ctx.tmpDir, ACCOUNT_ID)
  writeRunFixture(ctx.tmpDir, RUN_ID, 'running')
  writeRunFixture(ctx.tmpDir, '01KQEZ0000000000000000DON5', 'completed')
}

async function teardown(): Promise<void> {
  try { if (ctx.server) await ctx.server.kill() } catch (e) { console.error('teardown server kill failed', e) }
  try { if (ctx.tmpDir && fs.existsSync(ctx.tmpDir)) fs.rmSync(ctx.tmpDir, { recursive: true, force: true }) }
  catch (e) { console.error('teardown tmpDir cleanup failed', e) }
}

async function main(): Promise<void> {
  await setup()
  ctx.server = await spawnServer({
    port: PORT,
    dataDir: ctx.tmpDir,
    logPrefix: '[server]',
    readyTimeoutMs: 120_000,
  })

  // ── runs list ────────────────────────────────────────────
  {
    const r = cli(['runs', 'list'])
    assert(r.code === 0, `runs list exits 0 (got ${r.code})`)
    assert(r.stdout.includes(RUN_ID), `runs list output includes ${RUN_ID}`)
    assert(r.stdout.includes('STATUS'), 'runs list emits a header row')
  }
  {
    const r = cli(['runs', 'list', '--json'])
    assert(r.code === 0, `runs list --json exits 0 (got ${r.code})`)
    const body = JSON.parse(r.stdout) as { runs: unknown[] }
    assert(Array.isArray(body.runs), 'runs list --json returns {runs: array}')
  }
  {
    const r = cli(['runs', 'list', '--status', 'running'])
    assert(r.code === 0, 'runs list --status filters via query')
    assert(r.stdout.includes(RUN_ID), 'runs list --status=running includes the running run')
    assert(!r.stdout.includes('01KQEZ0000000000000000DON5'), 'runs list --status=running excludes the completed run')
  }

  // ── runs show ────────────────────────────────────────────
  {
    const r = cli(['runs', 'show', RUN_ID])
    assert(r.code === 0, `runs show exits 0 (got ${r.code})`)
    assert(r.stdout.includes(RUN_ID), 'runs show output includes the id')
    assert(r.stdout.includes(ACCOUNT_ID), 'runs show includes account')
    assert(r.stdout.includes('running'), 'runs show includes status line')
  }
  {
    const r = cli(['runs', 'show', '01KQEZ0000000000000000NONE'])
    assert(r.code !== 0, 'runs show on missing run exits non-zero')
  }

  // ── runs prompt ──────────────────────────────────────────
  {
    const r = cli(['runs', 'prompt', RUN_ID])
    assert(r.code === 0, `runs prompt exits 0 (got ${r.code})`)
    assert(r.stdout.includes('You are a helpful agent'), 'runs prompt streams the markdown body')
  }

  // ── runs messages (no workflowRunId → 503) ──────────────
  {
    const r = cli(['runs', 'messages', RUN_ID])
    assert(r.code !== 0, 'runs messages on run with no workflowRunId exits non-zero')
    assert(/503|not yet been started/.test(r.stderr + r.stdout), 'runs messages error mentions 503/not started')
  }

  // ── runs message (POST inbox) ────────────────────────────
  {
    const r = cli(['runs', 'message', RUN_ID, 'hello', 'agent'])
    assert(r.code === 0, `runs message exits 0 (got ${r.code})`)
    assert(r.stdout.includes('enqueued message'), 'runs message reports enqueued')
    const inbox = path.join(ctx.tmpDir, 'runs', RUN_ID, 'messages-inbox.jsonl')
    assert(fs.existsSync(inbox), `inbox file exists`)
    const line = fs.readFileSync(inbox, 'utf-8').trim().split('\n')[0]
    const parsed = JSON.parse(line) as { content: string }
    assert(parsed.content === 'hello agent', 'inbox carries joined argv text')
  }

  // ── runs cancel ──────────────────────────────────────────
  {
    const r = cli(['runs', 'cancel', RUN_ID])
    assert(r.code === 0, `runs cancel exits 0 (got ${r.code})`)
    assert(r.stdout.includes('cancelled'), 'runs cancel reports cancelled')
  }
  {
    const r = cli(['runs', 'cancel', RUN_ID])
    assert(r.code === 0, 'runs cancel idempotent on already-cancelled')
  }

  // ── signals list (empty store) ───────────────────────────
  {
    const r = cli(['signals', 'list'])
    assert(r.code === 0, `signals list exits 0 (got ${r.code})`)
    assert(/\(no signals\)/.test(r.stdout), 'signals list says (no signals) on empty store')
  }
  {
    const r = cli(['signals', 'list', '--status', 'pending', '--json'])
    assert(r.code === 0, 'signals list --status pending --json exits 0')
    const body = JSON.parse(r.stdout) as { signals: unknown[] }
    assert(Array.isArray(body.signals), '--json returns {signals: array}')
  }

  // ── signals resolve invalid decision ─────────────────────
  {
    const r = cli(['signals', 'resolve', 'sig-x', 'bogus'])
    assert(r.code !== 0, 'signals resolve rejects unknown decision')
  }

  // ── accounts list ────────────────────────────────────────
  {
    const r = cli(['accounts', 'list'])
    assert(r.code === 0, `accounts list exits 0 (got ${r.code})`)
    assert(r.stdout.includes(ACCOUNT_ID), `accounts list includes ${ACCOUNT_ID}`)
    assert(r.stdout.includes('Alice'), 'accounts list includes display name')
  }

  // ── accounts add (idempotent) ────────────────────────────
  {
    const r = cli(['accounts', 'add', 'cli-test:bob', '--display-name', 'Bob'])
    assert(r.code === 0, `accounts add new exits 0 (got ${r.code})`)
    assert(/cli-test:bob/.test(r.stdout), 'accounts add reports id')
  }
  {
    const r = cli(['accounts', 'add', 'cli-test:bob', '--display-name', 'IGNORED'])
    assert(r.code === 0, `accounts add re-add exits 0`)
  }

  // ── accounts show ────────────────────────────────────────
  {
    const r = cli(['accounts', 'show', ACCOUNT_ID])
    assert(r.code === 0, `accounts show exits 0`)
    assert(r.stdout.includes(ACCOUNT_ID), 'accounts show includes id')
    assert(r.stdout.includes('Alice'), 'accounts show includes display name')
  }

  // ── accounts env put / get / delete ──────────────────────
  {
    const tempContent = path.join(ctx.tmpDir, '_env-put-content.md')
    fs.writeFileSync(tempContent, '# Persona\n\nA cheerful agent.\n')
    const r = cli(['accounts', 'env', 'put', ACCOUNT_ID, 'persona.md', '-c', tempContent])
    assert(r.code === 0, `accounts env put exits 0 (got ${r.code}, stderr=${r.stderr.slice(0, 200)})`)
    assert(/wrote \d+ bytes/.test(r.stdout), 'env put reports byte count')
  }
  {
    const r = cli(['accounts', 'env', 'get', ACCOUNT_ID, 'persona.md'])
    assert(r.code === 0, 'accounts env get exits 0')
    assert(r.stdout.includes('cheerful agent'), 'env get streams content')
  }
  {
    const r = cli(['accounts', 'env', 'delete', ACCOUNT_ID, 'persona.md'])
    assert(r.code === 0, 'accounts env delete exits 0')
    assert(/deleted=true/.test(r.stdout), 'delete reports deleted=true')
  }

  // ── teams list / show ────────────────────────────────────
  {
    const r = cli(['teams', 'list'])
    assert(r.code === 0, `teams list exits 0 (got ${r.code})`)
    assert(r.stdout.includes(TEAM_NAME), 'teams list includes the team')
  }
  {
    const r = cli(['teams', 'show', TEAM_NAME])
    assert(r.code === 0, `teams show exits 0`)
    assert(r.stdout.includes(TEAM_NAME), 'teams show includes name')
    assert(r.stdout.includes('engagement-lead'), 'teams show includes lead role')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
}

main()
  .then(async () => { await teardown(); process.exit(failed === 0 ? 0 : 1) })
  .catch(async (e) => { console.error(e); await teardown(); process.exit(1) })
