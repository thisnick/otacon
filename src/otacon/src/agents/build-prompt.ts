/**
 * Build the system prompt for a session.
 *
 * Concatenates (in order, separated by `---`):
 *   1. Team's lead prompt file (e.g. `prompts/lead.md`)
 *   2. Each `*.md` under the workspace's `env/` (in lexicographic order)
 *   3. A static "available tools" reference (otacon subcommand list)
 *   4. Context block: workspace id, current time, timezone
 *
 * The result is what Pi's Agent gets via `state.systemPrompt`.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { otaconRegistry } from 'otacon-cli/commands/otacon'
import { workspaceEnvDir } from '../storage/paths.js'
import { readTeam, readTeamPrompt } from '../storage/team.js'
import type { Workspace } from '../types.js'

export interface BuildPromptOpts {
  dataRoot: string
  workspace: Workspace
  teamName: string
  agentRole: string
}

export async function buildSystemPrompt(opts: BuildPromptOpts): Promise<string> {
  const team = await readTeam(opts.dataRoot, opts.teamName)
  if (!team) throw new Error(`team "${opts.teamName}" not found`)
  const agent = team.agents.find(a => a.role === opts.agentRole)
  if (!agent) throw new Error(`agent role "${opts.agentRole}" not found in team "${opts.teamName}"`)

  const parts: string[] = []
  const main = await readTeamPrompt(opts.dataRoot, opts.teamName, agent.promptFile)
  if (main) parts.push(main)

  const envDir = workspaceEnvDir(opts.dataRoot, opts.workspace.id)
  const envFiles = await listMdFiles(envDir)
  for (const f of envFiles) {
    const content = await fs.readFile(path.join(envDir, f), 'utf8')
    parts.push(`# Workspace ${f.replace(/\.md$/, '')}\n\n${content}`)
  }

  parts.push(buildToolReference())

  parts.push([
    '## Context',
    `- Workspace: ${opts.workspace.id} (${opts.workspace.kind})`,
    `- Current time: ${new Date().toISOString()}`,
    `- Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
  ].join('\n'))

  return parts.join('\n\n---\n\n')
}

async function listMdFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir)
    return entries.filter(e => e.endsWith('.md')).sort()
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

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
  lines.push('- `otacon-alloc provision` — confirms phone is bound for this session.')
  lines.push('')
  lines.push('### Other shell utilities')
  lines.push('Standard utilities available via the sandbox: `cat`, `echo`, `ls`, `grep`, `cd`. The `memory/` dir is read/write across sessions; `env/` is read-only context; `traces/` holds this session\'s screenshots.')
  return lines.join('\n')
}
