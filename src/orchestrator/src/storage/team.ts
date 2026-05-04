/**
 * Team store — manages `${dataRoot}/teams/<name>/team.{yaml,json}` plus
 * prompt markdown files at `prompts/*.md`.
 *
 * Phase I migrates the canonical config from `team.json` to `team.yaml`.
 * Reader accepts either; writer always emits YAML and removes any stale
 * `team.json` so subsequent reads aren't ambiguous. If both exist on
 * read, YAML wins.
 *
 * Team configs live separately from workspaces because they're shared
 * across multiple workspaces of the same `expectedWorkspaceKind`.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  teamConfigFileJson,
  teamConfigFileYaml,
  teamPromptFile,
  teamPromptsDir,
  teamRoot,
} from './paths.js'
import { seedTemplatesRoot } from './seed-templates.js'
import type { Team } from '../types.js'

export async function readTeam(root: string, name: string): Promise<Team | null> {
  // Prefer YAML (Phase I canonical); fall back to JSON for legacy data.
  const yamlPath = teamConfigFileYaml(root, name)
  const jsonPath = teamConfigFileJson(root, name)
  try {
    const raw = await fs.readFile(yamlPath, 'utf8')
    return parseYaml(raw) as Team
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  try {
    const raw = await fs.readFile(jsonPath, 'utf8')
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

/**
 * Write the team config as YAML. If a stale `team.json` exists from
 * pre-Phase-I, delete it so subsequent reads aren't ambiguous.
 */
export async function writeTeam(root: string, team: Team): Promise<void> {
  await fs.mkdir(teamRoot(root, team.name), { recursive: true })
  const yaml = stringifyYaml(team)
  await fs.writeFile(teamConfigFileYaml(root, team.name), yaml, 'utf8')
  try {
    await fs.unlink(teamConfigFileJson(root, team.name))
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

export async function writeTeamPrompt(
  root: string,
  team: string,
  file: string,
  content: string,
): Promise<void> {
  const dir = teamPromptsDir(root, team)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(teamPromptFile(root, team, file), content, 'utf8')
}

export async function deleteTeamPrompt(
  root: string,
  team: string,
  file: string,
): Promise<boolean> {
  try {
    await fs.unlink(teamPromptFile(root, team, file))
    return true
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

export async function listTeamNames(root: string): Promise<string[]> {
  const teamsRoot = path.join(root, 'teams')
  let entries: string[]
  try {
    entries = await fs.readdir(teamsRoot)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const out: string[] = []
  for (const name of entries) {
    try {
      const stat = await fs.stat(path.join(teamsRoot, name))
      if (!stat.isDirectory()) continue
      const t = await readTeam(root, name)
      if (t) out.push(name)
    } catch {
      // skip
    }
  }
  return out
}

export async function deleteTeam(root: string, name: string): Promise<void> {
  await fs.rm(teamRoot(root, name), { recursive: true, force: true })
}

/**
 * Read the seed-default `team.yaml` for a given team name. Returns null
 * if no template exists (user-created team that never had a default).
 */
export async function readTeamDefault(name: string): Promise<Team | null> {
  const file = path.join(seedTemplatesRoot(), 'teams', name, 'team.yaml')
  try {
    const raw = await fs.readFile(file, 'utf8')
    return parseYaml(raw) as Team
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * Read the seed-default prompt file for a given team + role. Returns
 * null if no default exists.
 */
export async function readTeamPromptDefault(
  team: string,
  file: string,
): Promise<string | null> {
  const p = path.join(seedTemplatesRoot(), 'teams', team, 'prompts', file)
  try {
    return await fs.readFile(p, 'utf8')
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * Bootstrap a team into the data root from seed-templates. Idempotent —
 * never overwrites existing team.yaml or prompt files. Returns the list
 * of files written so seed.ts can report what changed.
 */
export async function seedDefaultTeam(
  root: string,
  name: string,
): Promise<string[]> {
  const tplRoot = path.join(seedTemplatesRoot(), 'teams', name)
  const written: string[] = []
  try {
    await fs.access(tplRoot)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return written
    throw e
  }
  // team.yaml — only if neither yaml nor json exists.
  const existing = await readTeam(root, name)
  if (!existing) {
    const def = await readTeamDefault(name)
    if (def) {
      await writeTeam(root, def)
      written.push('team.yaml')
    }
  }
  // prompts/*.md — per-file idempotent.
  const promptsTpl = path.join(tplRoot, 'prompts')
  let entries: string[] = []
  try {
    entries = await fs.readdir(promptsTpl)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  for (const file of entries) {
    if (!file.endsWith('.md')) continue
    const dest = teamPromptFile(root, name, file)
    try {
      await fs.access(dest)
      continue
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    const content = await fs.readFile(path.join(promptsTpl, file), 'utf8')
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, content, 'utf8')
    written.push(`prompts/${file}`)
  }
  return written
}

/**
 * List team names that have seed-templates available. Used by seed.ts
 * to know which teams to bootstrap on first run.
 */
export async function listSeedTeamNames(): Promise<string[]> {
  const dir = path.join(seedTemplatesRoot(), 'teams')
  try {
    const entries = await fs.readdir(dir)
    const out: string[] = []
    for (const name of entries) {
      const stat = await fs.stat(path.join(dir, name))
      if (stat.isDirectory()) out.push(name)
    }
    return out
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}
