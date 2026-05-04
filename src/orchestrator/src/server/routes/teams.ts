/**
 * Team CRUD + per-agent prompt routes (Phase I).
 *
 *   GET    /api/v1/teams[?workspaceKind=social]
 *   POST   /api/v1/teams
 *   GET    /api/v1/teams/:name
 *   PATCH  /api/v1/teams/:name
 *   DELETE /api/v1/teams/:name[?force=true]
 *
 * Per-agent prompts (markdown):
 *   GET    /api/v1/teams/:name/prompts/:role          (text/markdown)
 *   PUT    /api/v1/teams/:name/prompts/:role          (text/markdown body)
 *
 * Reset to seed defaults:
 *   POST   /api/v1/teams/:name/reset                   (returns Team)
 *   POST   /api/v1/teams/:name/prompts/:role/reset     (returns text/markdown)
 *
 * `agents[].promptFile` is computed by the server (`<role>.md`); clients
 * never set it directly. Adding/removing agents via PATCH on the
 * `agents` array triggers prompt-file lifecycle: server seeds an empty
 * file on add (or copies the seed-default if one exists), removes the
 * file on agent removal.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  deleteTeam,
  deleteTeamPrompt,
  listTeamNames,
  readTeam,
  readTeamDefault,
  readTeamPrompt,
  readTeamPromptDefault,
  writeTeam,
  writeTeamPrompt,
} from '../../storage/team.js'
import type { AgentRoleConfig, Team } from '../../types.js'
import { apiError } from '../errors.js'

export interface TeamsContext {
  dataRoot: string
}

// Team name + agent role: lowercase letters, digits, dashes; 1-64 chars.
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const ROLE_PATTERN = NAME_PATTERN

interface CreateTeamBody {
  name?: unknown
  description?: unknown
  expectedWorkspaceKind?: unknown
  lead?: unknown
  agents?: unknown
}

interface PatchTeamBody {
  description?: unknown
  expectedWorkspaceKind?: unknown
  lead?: unknown
  agents?: unknown
}

interface AgentInput {
  role?: unknown
  model?: unknown
}

export function makeTeamsRoutes(ctx: TeamsContext): Hono {
  const app = new Hono()

  // ---------------------------------------------------------------------------
  // Teams — list + create
  // ---------------------------------------------------------------------------

  app.get('/teams', async (c) => {
    const workspaceKind = c.req.query('workspaceKind')
    const names = await listTeamNames(ctx.dataRoot)
    const teams: Team[] = []
    for (const name of names) {
      const t = await readTeam(ctx.dataRoot, name)
      if (t) teams.push(t)
    }
    const filtered = workspaceKind
      ? teams.filter(t => t.expectedWorkspaceKind === workspaceKind)
      : teams
    filtered.sort((a, b) => a.name.localeCompare(b.name))
    return c.json(filtered)
  })

  app.post('/teams', async (c) => {
    let body: CreateTeamBody
    try {
      body = await c.req.json<CreateTeamBody>()
    } catch {
      return apiError(c, 'bad_request', 'request body must be valid JSON')
    }
    const { name, description, expectedWorkspaceKind, lead, agents } = body
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      return apiError(c, 'bad_request',
        `invalid team name "${String(name)}" — must match /[a-z0-9][a-z0-9-]{0,63}/`,
        { name })
    }
    if (typeof description !== 'string') {
      return apiError(c, 'bad_request', 'missing required field "description"')
    }
    if (typeof expectedWorkspaceKind !== 'string' || expectedWorkspaceKind.length === 0) {
      return apiError(c, 'bad_request', 'missing required field "expectedWorkspaceKind"')
    }
    const existing = await readTeam(ctx.dataRoot, name)
    if (existing) {
      return apiError(c, 'team_already_exists', `team "${name}" already exists`, { name })
    }
    const validatedAgents = parseAgentsInput(agents)
    if (typeof validatedAgents === 'string') {
      return apiError(c, 'bad_request', validatedAgents)
    }
    const leadStr = typeof lead === 'string' ? lead : ''
    if (validatedAgents.length > 0) {
      if (!leadStr) {
        return apiError(c, 'bad_request',
          '"lead" is required when creating a team with agents')
      }
      if (!validatedAgents.some(a => a.role === leadStr)) {
        return apiError(c, 'bad_request',
          `"lead" "${leadStr}" must match one of the agent roles`,
          { lead: leadStr, roles: validatedAgents.map(a => a.role) })
      }
    }
    const team: Team = {
      name,
      description,
      expectedWorkspaceKind,
      lead: leadStr,
      agents: validatedAgents,
    }
    await writeTeam(ctx.dataRoot, team)
    // Seed prompt files. For each agent: copy default if available, else
    // create an empty file so the loader can find it.
    for (const agent of validatedAgents) {
      const def = await readTeamPromptDefault(name, agent.promptFile)
      await writeTeamPrompt(ctx.dataRoot, name, agent.promptFile, def ?? '')
    }
    return c.json(team, 201)
  })

  // ---------------------------------------------------------------------------
  // Teams — single get / patch / delete / reset
  // ---------------------------------------------------------------------------

  app.get('/teams/:name', async (c) => {
    const name = decodeURIComponent(c.req.param('name'))
    const team = await readTeam(ctx.dataRoot, name)
    if (!team) return notFoundTeam(c, name)
    return c.json(team)
  })

  app.patch('/teams/:name', async (c) => {
    const name = decodeURIComponent(c.req.param('name'))
    const team = await readTeam(ctx.dataRoot, name)
    if (!team) return notFoundTeam(c, name)
    let body: PatchTeamBody
    try {
      body = await c.req.json<PatchTeamBody>()
    } catch {
      return apiError(c, 'bad_request', 'request body must be valid JSON')
    }
    const next: Team = { ...team, agents: [...team.agents] }
    if (body.description !== undefined) {
      if (typeof body.description !== 'string') {
        return apiError(c, 'bad_request', '"description" must be a string')
      }
      next.description = body.description
    }
    if (body.expectedWorkspaceKind !== undefined) {
      if (typeof body.expectedWorkspaceKind !== 'string' || body.expectedWorkspaceKind.length === 0) {
        return apiError(c, 'bad_request', '"expectedWorkspaceKind" must be a non-empty string')
      }
      next.expectedWorkspaceKind = body.expectedWorkspaceKind
    }
    if (body.lead !== undefined) {
      if (typeof body.lead !== 'string') {
        return apiError(c, 'bad_request', '"lead" must be a string')
      }
      next.lead = body.lead
    }

    // Agents diff: compute prompt file lifecycle. For roles that already
    // exist on the team, preserve the existing `promptFile` so seed-time
    // filename conventions (e.g. `lead.md` for `engagement-lead`) survive
    // a PATCH that re-sends the agents array.
    let added: AgentRoleConfig[] = []
    let removed: AgentRoleConfig[] = []
    if (body.agents !== undefined) {
      const newAgents = parseAgentsInput(body.agents)
      if (typeof newAgents === 'string') {
        return apiError(c, 'bad_request', newAgents)
      }
      const byRole = new Map(team.agents.map(a => [a.role, a]))
      const reconciled = newAgents.map(a => {
        const prev = byRole.get(a.role)
        return prev ? { ...a, promptFile: prev.promptFile } : a
      })
      const oldRoles = new Set(team.agents.map(a => a.role))
      const newRoles = new Set(reconciled.map(a => a.role))
      added = reconciled.filter(a => !oldRoles.has(a.role))
      removed = team.agents.filter(a => !newRoles.has(a.role))
      next.agents = reconciled
    }

    if (next.agents.length > 0 && next.lead) {
      if (!next.agents.some(a => a.role === next.lead)) {
        return apiError(c, 'bad_request',
          `"lead" "${next.lead}" must match one of the agent roles`,
          { lead: next.lead, roles: next.agents.map(a => a.role) })
      }
    }

    await writeTeam(ctx.dataRoot, next)
    for (const a of added) {
      const existing = await readTeamPrompt(ctx.dataRoot, name, a.promptFile)
      if (existing === null) {
        const def = await readTeamPromptDefault(name, a.promptFile)
        await writeTeamPrompt(ctx.dataRoot, name, a.promptFile, def ?? '')
      }
    }
    for (const a of removed) {
      await deleteTeamPrompt(ctx.dataRoot, name, a.promptFile)
    }
    return c.json(next)
  })

  app.delete('/teams/:name', async (c) => {
    const name = decodeURIComponent(c.req.param('name'))
    const team = await readTeam(ctx.dataRoot, name)
    if (!team) return notFoundTeam(c, name)
    // Plan §5.3 lists `?force=true` but doesn't define what's behind the
    // flag for teams (no per-team session count — sessions live under
    // workspaces). Treat force as "yes I really mean it" gate; without
    // it, refuse. With it, hard-delete.
    const force = c.req.query('force') === 'true'
    if (!force) {
      return apiError(c, 'bad_request',
        `team "${name}" delete requires ?force=true (cascade-deletes prompt files + team.yaml)`,
        { name })
    }
    await deleteTeam(ctx.dataRoot, name)
    return c.body(null, 204)
  })

  app.post('/teams/:name/reset', async (c) => {
    const name = decodeURIComponent(c.req.param('name'))
    const team = await readTeam(ctx.dataRoot, name)
    if (!team) return notFoundTeam(c, name)
    const def = await readTeamDefault(name)
    if (!def) {
      return apiError(c, 'no_default_for_team',
        `no seed-default exists for team "${name}"`, { name })
    }
    await writeTeam(ctx.dataRoot, def)
    return c.json(def)
  })

  // ---------------------------------------------------------------------------
  // Per-agent prompts
  // ---------------------------------------------------------------------------

  app.get('/teams/:name/prompts/:role', async (c) => {
    const name = decodeURIComponent(c.req.param('name'))
    const role = decodeURIComponent(c.req.param('role'))
    const team = await readTeam(ctx.dataRoot, name)
    if (!team) return notFoundTeam(c, name)
    if (!ROLE_PATTERN.test(role)) {
      return apiError(c, 'bad_request', `invalid agent role "${role}"`, { role })
    }
    const agent = team.agents.find(a => a.role === role)
    if (!agent) {
      return apiError(c, 'agent_role_not_found',
        `team "${name}" has no agent with role "${role}"`, { name, role })
    }
    const content = await readTeamPrompt(ctx.dataRoot, name, agent.promptFile)
    if (content === null) {
      // File should exist for a registered agent; treat missing as empty
      // rather than 404 so the UI can write into it.
      return new Response('', {
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      })
    }
    return new Response(content, {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    })
  })

  app.put('/teams/:name/prompts/:role', async (c) => {
    const name = decodeURIComponent(c.req.param('name'))
    const role = decodeURIComponent(c.req.param('role'))
    const team = await readTeam(ctx.dataRoot, name)
    if (!team) return notFoundTeam(c, name)
    if (!ROLE_PATTERN.test(role)) {
      return apiError(c, 'bad_request', `invalid agent role "${role}"`, { role })
    }
    const agent = team.agents.find(a => a.role === role)
    if (!agent) {
      return apiError(c, 'agent_role_not_found',
        `team "${name}" has no agent with role "${role}"`, { name, role })
    }
    const content = await c.req.text()
    await writeTeamPrompt(ctx.dataRoot, name, agent.promptFile, content)
    return c.body(null, 204)
  })

  app.post('/teams/:name/prompts/:role/reset', async (c) => {
    const name = decodeURIComponent(c.req.param('name'))
    const role = decodeURIComponent(c.req.param('role'))
    const team = await readTeam(ctx.dataRoot, name)
    if (!team) return notFoundTeam(c, name)
    if (!ROLE_PATTERN.test(role)) {
      return apiError(c, 'bad_request', `invalid agent role "${role}"`, { role })
    }
    const agent = team.agents.find(a => a.role === role)
    if (!agent) {
      return apiError(c, 'agent_role_not_found',
        `team "${name}" has no agent with role "${role}"`, { name, role })
    }
    const def = await readTeamPromptDefault(name, agent.promptFile)
    if (def === null) {
      return apiError(c, 'no_default_for_file',
        `no seed-default exists for prompt "${agent.promptFile}" in team "${name}"`,
        { name, role, file: agent.promptFile })
    }
    await writeTeamPrompt(ctx.dataRoot, name, agent.promptFile, def)
    return new Response(def, {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    })
  })

  return app
}

function notFoundTeam(c: Context, name: string) {
  return apiError(c, 'team_not_found', `team "${name}" not found`, { teamName: name })
}

/**
 * Validate an `agents` input. Returns the validated array on success or
 * an error message string on failure. The server computes
 * `promptFile = "<role>.md"`; clients never supply it.
 */
function parseAgentsInput(input: unknown): AgentRoleConfig[] | string {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) return '"agents" must be an array when provided'
  const out: AgentRoleConfig[] = []
  const seen = new Set<string>()
  for (const raw of input as AgentInput[]) {
    if (!raw || typeof raw !== 'object') {
      return 'each agent must be an object'
    }
    const { role, model } = raw
    if (typeof role !== 'string' || !ROLE_PATTERN.test(role)) {
      return `invalid agent role "${String(role)}" — must match /[a-z0-9][a-z0-9-]{0,63}/`
    }
    if (seen.has(role)) {
      return `duplicate agent role "${role}"`
    }
    seen.add(role)
    if (typeof model !== 'string' || model.length === 0) {
      return `agent "${role}" missing required "model" string`
    }
    out.push({ role, model, promptFile: `${role}.md` })
  }
  return out
}
