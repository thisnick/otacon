/**
 * `teams` group — HTTP-backed CLI subcommands (P3-I).
 *
 *   teams list [--json]
 *   teams show <name> [--json]
 */
import { makeApiClient } from './api-client.js'

interface TeamMeta {
  name: string
  lead?: string
  agentCount?: number
}

export async function teamsListCommand(opts: { json?: boolean; url?: string }): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const body = await api.get<{ teams: TeamMeta[] }>('/api/v1/teams')
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2))
    return
  }
  if (body.teams.length === 0) {
    console.log('(no teams)')
    return
  }
  for (const t of body.teams) {
    console.log(`${t.name}    lead=${t.lead ?? '?'}    agents=${t.agentCount ?? '?'}`)
  }
}

export async function teamsShowCommand(opts: {
  name: string
  json?: boolean
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const body = await api.get<{ team: unknown }>(`/api/v1/teams/${encodeURIComponent(opts.name)}`)
  console.log(JSON.stringify(body.team, null, 2))
}
