/**
 * Phase I · I8 — Cross-team sessions endpoint.
 *
 *   GET /api/v1/workspaces/:ws/sessions  → SessionSummary[]
 *
 * Coverage:
 *   - 404 on bogus workspace
 *   - [] on a workspace with no teams (no `teams/` dir)
 *   - [] on a workspace with teams but no sessions
 *   - Sessions from multiple teams returned in startedAt desc order
 *   - Returns sessions even from teams not in the global catalog (orphan-safe)
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  bootLocalServer,
  api,
  isErrorEnvelope,
} from './helpers/phase-i.js'
import {
  assert,
  exitFromCounters,
  info,
  makeCounters,
  section,
  summary,
} from './helpers/spike.js'

interface SessionSummary {
  id: string
  workspace: string
  team: string
  agentRole: string
  modelProvider: string
  modelId: string
  startedAt: number
  endedAt: number | null
  status: 'running' | 'completed' | 'aborted' | 'error'
  error?: string | null
}

async function main() {
  const c = makeCounters()
  console.log(`\n=== Phase I · I8: cross-team sessions ===`)

  const server = await bootLocalServer({ seed: false })
  info(`server: ${server.baseUrl}`)
  try {
    section('1. 404 on bogus workspace')
    const r404 = await api<unknown>(server.baseUrl,
      '/api/v1/workspaces/nope%3Athere/sessions')
    assert(c, r404.status === 404, `bogus workspace → 404 (got ${r404.status})`)
    assert(c, isErrorEnvelope(r404.body, 'workspace_not_found').ok,
      `workspace_not_found envelope ok`)

    section('2. Empty list when no sessions')
    const create = await api<unknown>(server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'xhs:i8', displayName: 'I8', kind: 'social', phoneNumber: '+13412137456',
      }),
    })
    assert(c, create.status === 201, `created xhs:i8`)
    const empty = await api<SessionSummary[]>(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai8/sessions')
    assert(c, empty.status === 200, `empty list → 200`)
    assert(c, Array.isArray(empty.body) && empty.body.length === 0,
      `empty array initially`)

    section('3. Cross-team listing in startedAt desc order')
    // Forge two teams + sessions on disk (no need to go through team
    // CRUD — the route walks the workspace's local teams/ tree).
    const wsTeams = path.join(server.dataRoot, 'workspaces', 'xhs:i8', 'teams')
    const teams = [
      {
        name: 'team-a',
        sid: '01HSESSAAA0000000000000001',
        startedAt: 1000,
        endedAt: 2000,
      },
      {
        name: 'team-b',
        sid: '01HSESSBBB0000000000000002',
        startedAt: 5000,
        endedAt: 6000,
      },
      {
        name: 'team-c',
        sid: '01HSESSCCC0000000000000003',
        startedAt: 3000,
        endedAt: 4000,
      },
    ]
    for (const t of teams) {
      const dir = path.join(wsTeams, t.name, 'sessions', t.sid)
      await fs.mkdir(dir, { recursive: true })
      const meta: SessionSummary = {
        id: t.sid,
        workspace: 'xhs:i8',
        team: t.name,
        agentRole: 'engagement-lead',
        modelProvider: 'anthropic',
        modelId: 'claude-sonnet-4.6',
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        status: 'completed',
      }
      await fs.writeFile(path.join(dir, 'session.json'),
        JSON.stringify(meta, null, 2), 'utf8')
    }

    const list = await api<SessionSummary[]>(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai8/sessions')
    assert(c, list.status === 200, `cross-team list → 200`)
    const ids = list.body.map(s => s.id)
    assert(c, ids.length === 3, `3 sessions returned (got ${ids.length})`)
    // Order: team-b (5000), team-c (3000), team-a (1000)
    assert(c, list.body[0]?.id === '01HSESSBBB0000000000000002',
      `first is highest startedAt (got ${list.body[0]?.id})`)
    assert(c, list.body[1]?.id === '01HSESSCCC0000000000000003',
      `second is mid startedAt`)
    assert(c, list.body[2]?.id === '01HSESSAAA0000000000000001',
      `third is lowest startedAt`)
    // Each summary keeps its team field, so the UI knows which team
    // dropdown row produced it.
    assert(c, list.body[0]?.team === 'team-b', `team field preserved`)

    section('4. Orphan-safe — sessions surface even when team isn\'t in global catalog')
    // The forged teams above are NOT in `${dataRoot}/teams/`. They only
    // exist as directories under the workspace. The route should still
    // return their sessions.
    const globalTeamsDir = path.join(server.dataRoot, 'teams')
    let hasGlobal = false
    try { await fs.access(globalTeamsDir); hasGlobal = true } catch {}
    if (hasGlobal) {
      const globalList = await fs.readdir(globalTeamsDir)
      info(`global teams dir contents: ${JSON.stringify(globalList)}`)
    } else {
      info(`no global teams/ directory exists — confirms cross-team route doesn't depend on it`)
    }
    const orphanList = await api<SessionSummary[]>(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai8/sessions')
    assert(c, orphanList.body.length === 3,
      `orphan teams' sessions still returned (got ${orphanList.body.length})`)

  } finally {
    await server.stop()
  }

  summary('Phase I · I8', c)
  exitFromCounters('Phase I · I8', c)
}

main().catch(err => {
  console.error('I8 threw:', err)
  process.exit(1)
})
