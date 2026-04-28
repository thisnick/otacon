/**
 * Assembles system prompts from team files + auto-generated tool reference.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { otaconRegistry } from 'otacon-cli/commands/otacon'
import { buildAllocRegistry } from '../sandbox/alloc-commands.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function buildSystemPrompt(opts: {
  teamName: string
  promptFile: string
  accountId: string
}): Promise<string> {
  const { teamName, promptFile, accountId } = opts
  const teamDir = path.join(__dirname, '..', 'teams', teamName)

  const parts: string[] = []

  // Load main prompt file
  const mainPrompt = await readOptional(path.join(teamDir, promptFile))
  if (mainPrompt) parts.push(mainPrompt)

  // Load soul.md (persona)
  const soul = await readOptional(path.join(teamDir, 'soul.md'))
  if (soul) parts.push(soul)

  // Load tools.md (narrative)
  const tools = await readOptional(path.join(teamDir, 'tools.md'))
  if (tools) parts.push(tools)

  // Auto-generated bash command reference (from shared registries)
  parts.push(buildToolReference())

  // Dynamic context
  parts.push(`## Context
- Account: ${accountId}
- Current time: ${new Date().toISOString()}
- Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)

  return parts.join('\n\n---\n\n')
}

/**
 * Build the markdown tool reference from the shared otacon CLI registry
 * + the orchestrator-only otacon-alloc registry. Injected into the system
 * prompt so the agent always sees the current set of commands.
 */
export function buildToolReference(): string {
  const lines: string[] = []
  lines.push('## Available bash commands')
  lines.push('')

  lines.push('### otacon (phone control)')
  lines.push('Available subcommands (run `otacon <subcommand>`):')
  lines.push('')
  const sortedNames = Object.keys(otaconRegistry).sort()
  for (const name of sortedNames) {
    const spec = otaconRegistry[name]
    lines.push(`- \`${spec.usage}\` — ${spec.description}`)
    for (const ex of spec.examples) {
      lines.push(`  - example: \`${ex}\``)
    }
  }
  lines.push('')

  lines.push('### otacon-alloc (phone allocation)')
  lines.push('Manage the lease that grants the agent phone access.')
  lines.push('')
  // Build a placeholder alloc registry just to read names/descriptions.
  // The actual context (db, accountId, conversationId) doesn't matter — we
  // only enumerate static metadata.
  const placeholderRegistry = buildAllocRegistry({
    db: null as any,
    accountId: '',
    conversationId: '',
    allocCtx: { peek: () => null, get: () => null, set: () => {}, clear: () => {} } as any,
  })
  for (const name of Object.keys(placeholderRegistry).sort()) {
    const spec = placeholderRegistry[name]
    lines.push(`- \`${spec.usage}\` — ${spec.description}`)
    for (const ex of spec.examples) {
      lines.push(`  - example: \`${ex}\``)
    }
  }
  lines.push('')

  lines.push('### Other shell utilities')
  lines.push('Standard utilities available via the sandbox: `cat`, `echo`, `ls`, `grep`, `cd`, etc. Files persist in `/workspace`.')

  return lines.join('\n')
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}
