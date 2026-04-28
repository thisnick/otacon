/**
 * Assembles system prompts from team files + dynamic context.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

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

  // Load tools.md
  const tools = await readOptional(path.join(teamDir, 'tools.md'))
  if (tools) parts.push(tools)

  // Dynamic context
  parts.push(`## Context
- Account: ${accountId}
- Current time: ${new Date().toISOString()}
- Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)

  return parts.join('\n\n---\n\n')
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}
