/**
 * FS-backed system prompt builder.
 *
 * Reads team config + prompt files from the runtime data dir (via
 * TeamStore) instead of from the in-tree `src/teams/` source. This is
 * what `leadAgentWorkflow` calls at run start to render the prompt; the
 * output is snapshotted to `runs/{runId}/prompt.md` so old runs can
 * always show the exact prompt that was used.
 *
 * Replaces `src/agents/build-prompt.ts` for the orchestrator-v2 pipeline.
 * The legacy file stays in place for now to keep `pnpm orchestrator agent
 * run` (Drizzle-flavored) working until that path is removed.
 */
import type { TeamStore } from '../storage/team-store.js'
import { otaconRegistry } from 'otacon-cli/commands/otacon'
import { buildAllocRegistry } from '../sandbox/alloc-commands.js'

export interface BuildPromptOpts {
  teamStore: TeamStore
  teamName: string
  agentRole: string
  accountId: string
}

export async function buildSystemPromptFs(opts: BuildPromptOpts): Promise<string> {
  const { teamStore, teamName, agentRole, accountId } = opts

  const team = await teamStore.get(teamName)
  if (!team) {
    throw new Error(
      `team "${teamName}" not seeded — run \`pnpm orchestrator service seed-team --name ${teamName}\` first`,
    )
  }
  const agent = team.agents.find(a => a.role === agentRole)
  if (!agent) {
    throw new Error(`agent role "${agentRole}" not found in team "${teamName}"`)
  }

  const parts: string[] = []

  const main = await teamStore.readPromptFile(teamName, agent.promptFile)
  if (main) parts.push(main)

  const soul = await teamStore.readPromptFile(teamName, 'soul.md')
  if (soul) parts.push(soul)

  const tools = await teamStore.readPromptFile(teamName, 'tools.md')
  if (tools) parts.push(tools)

  parts.push(buildToolReference())

  parts.push(`## Context
- Account: ${accountId}
- Current time: ${new Date().toISOString()}
- Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)

  return parts.join('\n\n---\n\n')
}

/**
 * Auto-generated bash command reference. Mirrors `build-prompt.ts`'s
 * implementation — the registries are static, so the duplicated logic
 * is fine and avoids cross-importing the legacy module.
 */
function buildToolReference(): string {
  const lines: string[] = []
  lines.push('## Available bash commands')
  lines.push('')

  lines.push('### otacon (phone control)')
  lines.push('Available subcommands (run `otacon <subcommand>`):')
  lines.push('')
  for (const name of Object.keys(otaconRegistry).sort()) {
    const spec = otaconRegistry[name]
    lines.push(`- \`${spec.usage}\` — ${spec.description}`)
    for (const ex of spec.examples) lines.push(`  - example: \`${ex}\``)
  }
  lines.push('')

  lines.push('### otacon-alloc (phone allocation)')
  lines.push('Manage the lease that grants the agent phone access.')
  lines.push('')
  // Build a placeholder alloc registry just to read names/descriptions —
  // no DB / accountId needed for static metadata.
  const placeholder = buildAllocRegistry({
    db: null as unknown as Parameters<typeof buildAllocRegistry>[0]['db'],
    accountId: '',
    conversationId: '',
    allocCtx: { peek: () => null, get: () => null, set: () => undefined, clear: () => undefined } as unknown as Parameters<typeof buildAllocRegistry>[0]['allocCtx'],
  })
  for (const name of Object.keys(placeholder).sort()) {
    const spec = placeholder[name]
    lines.push(`- \`${spec.usage}\` — ${spec.description}`)
    for (const ex of spec.examples) lines.push(`  - example: \`${ex}\``)
  }
  lines.push('')

  lines.push('### Other shell utilities')
  lines.push('Standard utilities available via the sandbox: `cat`, `echo`, `ls`, `grep`, `cd`, etc. Files persist in `/workspace`.')

  return lines.join('\n')
}
