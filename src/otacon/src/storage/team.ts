/**
 * Team store — reads `.otacon-data/teams/<name>/team.json` + prompt files.
 *
 * Team configs live separately from workspaces because they're shared
 * across multiple workspaces of the same `expectedWorkspaceKind`.
 */
import * as fs from 'node:fs/promises'
import { teamConfigFile, teamPromptFile, teamRoot } from './paths.js'
import type { Team } from '../types.js'

export async function readTeam(root: string, name: string): Promise<Team | null> {
  try {
    const raw = await fs.readFile(teamConfigFile(root, name), 'utf8')
    return JSON.parse(raw) as Team
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export async function readTeamPrompt(
  root: string,
  team: string,
  file: string,
): Promise<string | null> {
  try {
    return await fs.readFile(teamPromptFile(root, team, file), 'utf8')
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export async function writeTeam(root: string, team: Team): Promise<void> {
  await fs.mkdir(teamRoot(root, team.name), { recursive: true })
  await fs.writeFile(teamConfigFile(root, team.name), JSON.stringify(team, null, 2), 'utf8')
}

export async function writeTeamPrompt(
  root: string,
  team: string,
  file: string,
  content: string,
): Promise<void> {
  const promptDir = teamPromptFile(root, team, '')
  await fs.mkdir(promptDir, { recursive: true })
  await fs.writeFile(teamPromptFile(root, team, file), content, 'utf8')
}
