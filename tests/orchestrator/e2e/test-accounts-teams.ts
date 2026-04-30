/**
 * E2E test for accounts + teams CRUD routes (P3-I).
 *
 * Pre-populates a tmp data dir, spawns the server, exercises:
 *   GET    /api/v1/accounts
 *   POST   /api/v1/accounts
 *   GET    /api/v1/accounts/:id
 *   GET    /api/v1/accounts/:id/env/:file
 *   PUT    /api/v1/accounts/:id/env/:file
 *   DELETE /api/v1/accounts/:id/env/:file
 *   GET    /api/v1/teams
 *   GET    /api/v1/teams/:name
 *
 * Allowlist enforcement (env file) covered with negative cases. No phone,
 * no LLM, no Workflow SDK.
 *
 * Run: pnpm test:e2e:accounts-teams
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnServer, type SpawnedServer } from './helpers/run-and-tail.js'

const PORT = process.env.ACCOUNTS_TEAMS_PORT ?? '9093'
const ACCOUNT_ID = 'p3test:alice'
const ACCOUNT_PHONE = '+15551234567'
const TEAM_NAME = 'social-media-engagement'

let passed = 0
let failed = 0

function assert(cond: unknown, msg: string): void {
  if (cond) { console.log(`  PASS  ${msg}`); passed++ }
  else { console.log(`  FAIL  ${msg}`); failed++ }
}

interface Ctx { tmpDir: string; server: SpawnedServer | null }
const ctx: Ctx = { tmpDir: '', server: null }

async function setup(): Promise<void> {
  ctx.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-accounts-teams-'))
  console.log(`\n=== accounts-teams e2e ===`)
  console.log(`tmpDir = ${ctx.tmpDir}`)

  // Pre-populate one team via FS (we don't go through `seed-team` here —
  // simpler to write a plausible team.json directly).
  const teamDir = path.join(ctx.tmpDir, 'teams', TEAM_NAME)
  fs.mkdirSync(path.join(teamDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(teamDir, 'team.json'), JSON.stringify({
    name: TEAM_NAME,
    lead: 'engagement-lead',
    agents: {
      'engagement-lead': { promptPath: 'prompts/engagement-lead.md' },
    },
  }, null, 2))
  fs.writeFileSync(path.join(teamDir, 'prompts/engagement-lead.md'), '# Lead\n')
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
  const base = ctx.server.baseUrl

  // ── GET /accounts on empty store ─────────────────────────
  {
    const r = await fetch(`${base}/api/v1/accounts`)
    assert(r.status === 200, `GET /accounts returns 200 (got ${r.status})`)
    const body = await r.json() as { accounts: unknown[] }
    assert(Array.isArray(body.accounts) && body.accounts.length === 0, 'GET /accounts empty on fresh store')
  }

  // ── POST /accounts (create) ──────────────────────────────
  {
    const r = await fetch(`${base}/api/v1/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: ACCOUNT_ID, displayName: 'Alice', phoneNumber: ACCOUNT_PHONE }),
    })
    assert(r.status === 200, `POST /accounts returns 200 (got ${r.status})`)
    const body = await r.json() as { account: { id: string; displayName: string | null } }
    assert(body.account.id === ACCOUNT_ID, `POST /accounts returns id=${ACCOUNT_ID}`)
    assert(body.account.displayName === 'Alice', 'POST /accounts persists displayName')
  }

  // ── POST /accounts idempotency ────────────────────────────
  {
    const r = await fetch(`${base}/api/v1/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: ACCOUNT_ID, displayName: 'IGNORED' }),
    })
    assert(r.status === 200, `POST /accounts (re-create) returns 200 (got ${r.status})`)
    const body = await r.json() as { account: { displayName: string | null } }
    assert(body.account.displayName === 'Alice', 'POST /accounts idempotent: keeps original displayName')
  }

  // ── POST /accounts validation ─────────────────────────────
  {
    const r = await fetch(`${base}/api/v1/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert(r.status === 400, `POST /accounts without id returns 400 (got ${r.status})`)
    await r.arrayBuffer()
  }
  {
    const r = await fetch(`${base}/api/v1/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '../etc/passwd' }),
    })
    assert(r.status === 400, `POST /accounts with unsafe id returns 400 (got ${r.status})`)
    await r.arrayBuffer()
  }

  // ── GET /accounts/:id ────────────────────────────────────
  {
    const r = await fetch(`${base}/api/v1/accounts/${encodeURIComponent(ACCOUNT_ID)}`)
    assert(r.status === 200, `GET /accounts/:id returns 200 (got ${r.status})`)
    const body = await r.json() as { account: { id: string } }
    assert(body.account.id === ACCOUNT_ID, 'GET /accounts/:id returns correct id')
  }
  {
    const r = await fetch(`${base}/api/v1/accounts/p3test:nope`)
    assert(r.status === 404, `GET /accounts/:id 404s on missing (got ${r.status})`)
    await r.arrayBuffer()
  }

  // ── GET /accounts now lists the new account ──────────────
  {
    const r = await fetch(`${base}/api/v1/accounts`)
    const body = await r.json() as { accounts: Array<{ id: string }> }
    assert(
      body.accounts.some(a => a.id === ACCOUNT_ID),
      'GET /accounts after create includes new account',
    )
  }

  // ── PUT env file (allowed) ───────────────────────────────
  {
    const r = await fetch(`${base}/api/v1/accounts/${encodeURIComponent(ACCOUNT_ID)}/env/persona.md`, {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown' },
      body: '# Persona\n\nA helpful assistant.\n',
    })
    assert(r.status === 200, `PUT env/persona.md returns 200 (got ${r.status})`)
    const body = await r.json() as { ok: boolean; bytes: number }
    assert(body.ok === true && body.bytes > 0, 'PUT env/persona.md returns ok+bytes')
  }

  // ── GET env file (allowed, content matches) ──────────────
  {
    const r = await fetch(`${base}/api/v1/accounts/${encodeURIComponent(ACCOUNT_ID)}/env/persona.md`)
    assert(r.status === 200, `GET env/persona.md returns 200 (got ${r.status})`)
    assert(
      (r.headers.get('content-type') ?? '').includes('text/markdown'),
      `GET env content-type=text/markdown (got ${r.headers.get('content-type')})`,
    )
    const body = await r.text()
    assert(body.includes('A helpful assistant'), 'GET env/persona.md returns the content we PUT')
  }

  // ── env file allowlist ───────────────────────────────────
  {
    const r = await fetch(`${base}/api/v1/accounts/${encodeURIComponent(ACCOUNT_ID)}/env/secrets.txt`, {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown' },
      body: 'pwned',
    })
    assert(r.status === 400, `PUT non-allowlist env file returns 400 (got ${r.status})`)
    await r.arrayBuffer()
  }
  {
    const r = await fetch(`${base}/api/v1/accounts/${encodeURIComponent(ACCOUNT_ID)}/env/secrets.txt`)
    assert(r.status === 400, `GET non-allowlist env file returns 400 (got ${r.status})`)
    await r.arrayBuffer()
  }

  // ── GET env file 404 (allowed name, not on disk) ─────────
  {
    const r = await fetch(`${base}/api/v1/accounts/${encodeURIComponent(ACCOUNT_ID)}/env/soul.md`)
    assert(r.status === 404, `GET env/soul.md (not written yet) returns 404 (got ${r.status})`)
    await r.arrayBuffer()
  }

  // ── DELETE env file ──────────────────────────────────────
  {
    const r = await fetch(`${base}/api/v1/accounts/${encodeURIComponent(ACCOUNT_ID)}/env/persona.md`, {
      method: 'DELETE',
    })
    assert(r.status === 200, `DELETE env/persona.md returns 200 (got ${r.status})`)
    const body = await r.json() as { ok: boolean; deleted: boolean }
    assert(body.deleted === true, 'DELETE env/persona.md reports deleted=true')
  }
  {
    // GET should now 404
    const r = await fetch(`${base}/api/v1/accounts/${encodeURIComponent(ACCOUNT_ID)}/env/persona.md`)
    assert(r.status === 404, `GET env/persona.md after DELETE returns 404 (got ${r.status})`)
    await r.arrayBuffer()
  }
  {
    // DELETE again — idempotent (deleted: false)
    const r = await fetch(`${base}/api/v1/accounts/${encodeURIComponent(ACCOUNT_ID)}/env/persona.md`, {
      method: 'DELETE',
    })
    assert(r.status === 200, `DELETE env/persona.md (already gone) returns 200 (got ${r.status})`)
    const body = await r.json() as { ok: boolean; deleted: boolean }
    assert(body.deleted === false, 'DELETE env on missing file: deleted=false (idempotent)')
  }

  // ── GET /teams ───────────────────────────────────────────
  {
    const r = await fetch(`${base}/api/v1/teams`)
    assert(r.status === 200, `GET /teams returns 200 (got ${r.status})`)
    const body = await r.json() as { teams: Array<{ name: string }> }
    assert(
      body.teams.some(t => t.name === TEAM_NAME),
      `GET /teams includes ${TEAM_NAME}`,
    )
  }
  {
    const r = await fetch(`${base}/api/v1/teams/${encodeURIComponent(TEAM_NAME)}`)
    assert(r.status === 200, `GET /teams/:name returns 200 (got ${r.status})`)
    const body = await r.json() as { team: { name: string; lead: string } }
    assert(body.team.name === TEAM_NAME, 'GET /teams/:name returns name')
    assert(body.team.lead === 'engagement-lead', 'GET /teams/:name returns lead role')
  }
  {
    const r = await fetch(`${base}/api/v1/teams/nonexistent-team`)
    assert(r.status === 404, `GET /teams/:name on missing returns 404 (got ${r.status})`)
    await r.arrayBuffer()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
}

main()
  .then(async () => { await teardown(); process.exit(failed === 0 ? 0 : 1) })
  .catch(async (e) => { console.error(e); await teardown(); process.exit(1) })
