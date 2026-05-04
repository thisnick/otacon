/**
 * Phase I · I4 — Teams CRUD + agent prompts + reset.
 *
 * Coverage:
 *   - GET /teams empty (no seed)
 *   - GET /teams[?workspaceKind=...] filter
 *   - POST /teams happy path + 201; lead must match an agent role
 *   - POST validation: bad name, missing description
 *   - POST duplicate → 409 team_already_exists
 *   - PATCH adds an agent → prompts/<role>.md gets created with empty (or seed-default)
 *   - PATCH removes an agent → prompts/<role>.md gets deleted
 *   - PATCH preserves existing agents' promptFile
 *   - GET / PUT /teams/:name/prompts/:role
 *   - POST /teams/:name/reset (seeded team) → returns Team
 *   - POST /teams/:name/reset (non-seeded team) → 404 no_default_for_team
 *   - DELETE without ?force=true → 400; with → 204
 *   - YAML on disk + json reader fallback
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  bootLocalServer,
  api,
  apiText,
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

interface AgentRoleConfig {
  role: string
  model: string
  promptFile: string
}
interface Team {
  name: string
  description: string
  expectedWorkspaceKind: string
  lead: string
  agents: AgentRoleConfig[]
}

async function main() {
  const c = makeCounters()
  console.log(`\n=== Phase I · I4: teams CRUD + prompts + reset ===`)

  const server = await bootLocalServer({ seed: true })
  info(`server: ${server.baseUrl}`)
  try {
    section('1. Seeded team is listed')
    const list1 = await api<Team[]>(server.baseUrl, '/api/v1/teams')
    assert(c, list1.status === 200, `GET /teams → 200`)
    assert(c, list1.body.some(t => t.name === 'social-media-engagement'),
      `seeded social-media-engagement present`)

    section('2. Filter by workspaceKind')
    const filtered = await api<Team[]>(server.baseUrl, '/api/v1/teams?workspaceKind=social')
    assert(c, filtered.status === 200, `filter → 200`)
    assert(c, filtered.body.length >= 1 &&
      filtered.body.every(t => t.expectedWorkspaceKind === 'social'),
      `all returned teams match filter`)
    const empty = await api<Team[]>(server.baseUrl, '/api/v1/teams?workspaceKind=nope')
    assert(c, empty.body.length === 0, `non-matching filter returns []`)

    section('3. POST validation errors')
    const badName = await api<unknown>(server.baseUrl, '/api/v1/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'BadName!', description: 'x', expectedWorkspaceKind: 'social' }),
    })
    assert(c, badName.status === 400, `bad name → 400`)
    assert(c, isErrorEnvelope(badName.body, 'bad_request').ok, `bad_request envelope ok`)

    const noDesc = await api<unknown>(server.baseUrl, '/api/v1/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'foo', expectedWorkspaceKind: 'social' }),
    })
    assert(c, noDesc.status === 400, `missing description → 400`)

    const leadMismatch = await api<unknown>(server.baseUrl, '/api/v1/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'foo', description: 'd', expectedWorkspaceKind: 'social',
        lead: 'nonexistent',
        agents: [{ role: 'engagement-lead', model: 'anthropic/claude-sonnet-4.6' }],
      }),
    })
    assert(c, leadMismatch.status === 400, `lead != any role → 400`)

    section('4. POST happy path (server computes promptFile)')
    const create = await api<Team>(server.baseUrl, '/api/v1/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'i4-team',
        description: 'I4 test team',
        expectedWorkspaceKind: 'social',
        lead: 'engagement-lead',
        agents: [{ role: 'engagement-lead', model: 'anthropic/claude-sonnet-4.6' }],
      }),
    })
    assert(c, create.status === 201, `POST team → 201`)
    assert(c, create.body.agents[0]?.promptFile === 'engagement-lead.md',
      `server computed promptFile = engagement-lead.md`)

    section('5. POST duplicate → 409')
    const dup = await api<unknown>(server.baseUrl, '/api/v1/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'i4-team', description: 'd', expectedWorkspaceKind: 'social',
        lead: 'engagement-lead',
        agents: [{ role: 'engagement-lead', model: 'anthropic/claude-sonnet-4.6' }],
      }),
    })
    assert(c, dup.status === 409, `dup → 409`)
    assert(c, isErrorEnvelope(dup.body, 'team_already_exists').ok,
      `team_already_exists envelope ok`)

    section('6. Per-agent prompt PUT/GET')
    const get1 = await apiText(server.baseUrl,
      '/api/v1/teams/i4-team/prompts/engagement-lead')
    assert(c, get1.status === 200, `GET prompt → 200`)
    assert(c, get1.contentType?.includes('text/markdown') === true,
      `prompt is text/markdown`)
    const put = await apiText(server.baseUrl,
      '/api/v1/teams/i4-team/prompts/engagement-lead', {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown' },
      body: '## CUSTOM\n',
    })
    assert(c, put.status === 204, `PUT prompt → 204`)
    const get2 = await apiText(server.baseUrl,
      '/api/v1/teams/i4-team/prompts/engagement-lead')
    assert(c, get2.raw === '## CUSTOM\n', `GET after PUT returns custom`)

    section('7. PATCH adds + removes agents (prompt file lifecycle)')
    const patch = await api<Team>(server.baseUrl, '/api/v1/teams/i4-team', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agents: [
          { role: 'engagement-lead', model: 'anthropic/claude-sonnet-4.6' },
          { role: 'researcher', model: 'anthropic/claude-sonnet-4.6' },
        ],
      }),
    })
    assert(c, patch.status === 200, `PATCH add → 200`)
    assert(c, patch.body.agents.find(a => a.role === 'researcher')?.promptFile === 'researcher.md',
      `researcher.md computed`)
    // existing engagement-lead prompt content should still be CUSTOM (not overwritten)
    const get3 = await apiText(server.baseUrl,
      '/api/v1/teams/i4-team/prompts/engagement-lead')
    assert(c, get3.raw === '## CUSTOM\n',
      `existing prompt preserved across PATCH`)

    // Verify prompts/researcher.md exists on disk.
    const promptsDir = path.join(server.dataRoot, 'teams', 'i4-team', 'prompts')
    const promptsList = await fs.readdir(promptsDir)
    assert(c, promptsList.includes('researcher.md'),
      `disk has researcher.md after PATCH-add`)

    const patch2 = await api<Team>(server.baseUrl, '/api/v1/teams/i4-team', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agents: [{ role: 'engagement-lead', model: 'anthropic/claude-sonnet-4.6' }],
      }),
    })
    assert(c, patch2.status === 200, `PATCH remove → 200`)
    const promptsList2 = await fs.readdir(promptsDir)
    assert(c, !promptsList2.includes('researcher.md'),
      `disk no longer has researcher.md after PATCH-remove`)

    section('8. Reset team (seeded) returns to default')
    // Mutate the seeded team, then reset.
    const mutate = await api<Team>(server.baseUrl,
      '/api/v1/teams/social-media-engagement', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'mutated description' }),
    })
    assert(c, mutate.status === 200 && mutate.body.description === 'mutated description',
      `mutated seeded team`)
    const reset = await api<Team>(server.baseUrl,
      '/api/v1/teams/social-media-engagement/reset', { method: 'POST' })
    assert(c, reset.status === 200, `reset → 200`)
    assert(c, reset.body.description !== 'mutated description',
      `description reverted to default`)

    section('9. Reset team without seed-default → 404')
    const noDef = await api<unknown>(server.baseUrl,
      '/api/v1/teams/i4-team/reset', { method: 'POST' })
    assert(c, noDef.status === 404, `no-default reset → 404`)
    assert(c, isErrorEnvelope(noDef.body, 'no_default_for_team').ok,
      `no_default_for_team envelope ok`)

    section('10. DELETE without force → 400; with force → 204')
    const delNoForce = await api<unknown>(server.baseUrl, '/api/v1/teams/i4-team',
      { method: 'DELETE' })
    assert(c, delNoForce.status === 400, `DELETE no force → 400`)
    const delForce = await api<unknown>(server.baseUrl, '/api/v1/teams/i4-team?force=true',
      { method: 'DELETE' })
    assert(c, delForce.status === 204, `DELETE with force → 204`)
    const get404 = await api<unknown>(server.baseUrl, '/api/v1/teams/i4-team')
    assert(c, get404.status === 404, `GET after delete → 404`)

    section('11. Disk shape: team.yaml + JSON-reader fallback')
    const teamYaml = path.join(server.dataRoot, 'teams', 'social-media-engagement', 'team.yaml')
    const onDisk = await fs.readFile(teamYaml, 'utf8')
    assert(c, onDisk.includes('expectedWorkspaceKind: social'),
      `team.yaml has expected camelCase keys`)

    // Plant a legacy team.json in a fresh dir + verify reader picks it up.
    const legacyName = 'i4-legacy-team'
    const legacyDir = path.join(server.dataRoot, 'teams', legacyName)
    await fs.mkdir(legacyDir, { recursive: true })
    const legacyTeam: Team = {
      name: legacyName,
      description: 'legacy',
      expectedWorkspaceKind: 'social',
      lead: '',
      agents: [],
    }
    await fs.writeFile(path.join(legacyDir, 'team.json'),
      JSON.stringify(legacyTeam, null, 2), 'utf8')
    const legacyGet = await api<Team>(server.baseUrl, `/api/v1/teams/${legacyName}`)
    assert(c, legacyGet.status === 200,
      `legacy team.json read → 200 (got ${legacyGet.status})`)
    assert(c, legacyGet.body.description === 'legacy',
      `legacy team.json content read correctly`)

    // After PATCH on legacy team, writer migrates to yaml + drops json.
    await api<Team>(server.baseUrl, `/api/v1/teams/${legacyName}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'migrated' }),
    })
    const yamlExists = await fs.access(path.join(legacyDir, 'team.yaml')).then(() => true).catch(() => false)
    const jsonExists = await fs.access(path.join(legacyDir, 'team.json')).then(() => true).catch(() => false)
    assert(c, yamlExists, `team.yaml created on PATCH`)
    assert(c, !jsonExists, `team.json removed on PATCH (one-shot migration)`)

  } finally {
    await server.stop()
  }

  summary('Phase I · I4', c)
  exitFromCounters('Phase I · I4', c)
}

main().catch(err => {
  console.error('I4 threw:', err)
  process.exit(1)
})
