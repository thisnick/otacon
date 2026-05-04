/**
 * Workspace env-file store — manages markdown files at
 *   `${dataRoot}/workspaces/<id>/env/*.md`
 *
 * Three default files are seeded on workspace create (`persona.md`,
 * `soul.md`, `memory.md`); users may add more (`anything.md`). Files are
 * plain markdown — no frontmatter, no schema.
 *
 * The agent reads these into its system prompt at run-start (alphabetical
 * order; documented in the API spec).
 *
 * Phase I one-shot migration: pre-Phase-I workspaces had `agents.md`
 * instead of `memory.md`. `migrateAgentsToMemory()` renames the file in
 * place if `memory.md` doesn't already exist. Idempotent.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { workspaceEnvDir } from './paths.js'
import { seedTemplatesRoot } from './seed-templates.js'

export interface EnvFileSummary {
  name: string
  size: number
  modifiedAt: number
}

const NAME_PATTERN = /^[a-zA-Z0-9._-]+\.md$/

/**
 * True if the proposed env-file name is safe to use as a path component.
 * Rejects path traversal (`..`), absolute paths, hidden files, and
 * non-`.md` extensions. The agent loads any `.md` file here verbatim into
 * the system prompt — non-markdown is rejected.
 */
export function isValidEnvFileName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) return false
  if (name.startsWith('.')) return false
  return NAME_PATTERN.test(name)
}

export async function listEnvFiles(
  root: string,
  workspaceId: string,
): Promise<EnvFileSummary[]> {
  const dir = workspaceEnvDir(root, workspaceId)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const out: EnvFileSummary[] = []
  for (const name of entries) {
    if (!isValidEnvFileName(name)) continue
    try {
      const stat = await fs.stat(path.join(dir, name))
      if (!stat.isFile()) continue
      out.push({ name, size: stat.size, modifiedAt: stat.mtimeMs })
    } catch {
      // skip
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export async function readEnvFile(
  root: string,
  workspaceId: string,
  name: string,
): Promise<string | null> {
  if (!isValidEnvFileName(name)) return null
  try {
    return await fs.readFile(path.join(workspaceEnvDir(root, workspaceId), name), 'utf8')
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export async function writeEnvFile(
  root: string,
  workspaceId: string,
  name: string,
  content: string,
): Promise<void> {
  if (!isValidEnvFileName(name)) throw new Error('invalid_env_file_name')
  const dir = workspaceEnvDir(root, workspaceId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name), content, 'utf8')
}

export async function deleteEnvFile(
  root: string,
  workspaceId: string,
  name: string,
): Promise<boolean> {
  if (!isValidEnvFileName(name)) return false
  try {
    await fs.unlink(path.join(workspaceEnvDir(root, workspaceId), name))
    return true
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

/**
 * Read the seed-template default content for an env file under a given
 * workspace kind. Returns null if no default exists for that file under
 * that kind (e.g. user-added `anything.md` has no default to revert to).
 */
export async function readEnvFileDefault(
  workspaceKind: string,
  name: string,
): Promise<string | null> {
  if (!isValidEnvFileName(name)) return null
  const file = path.join(seedTemplatesRoot(), 'workspaces', workspaceKind, name)
  try {
    return await fs.readFile(file, 'utf8')
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * One-shot Phase I migration: rename `agents.md` → `memory.md` if
 * `memory.md` doesn't already exist in this workspace's env dir.
 * Idempotent — safe to call on every workspace read.
 */
export async function migrateAgentsToMemory(
  root: string,
  workspaceId: string,
): Promise<boolean> {
  const dir = workspaceEnvDir(root, workspaceId)
  const agents = path.join(dir, 'agents.md')
  const memory = path.join(dir, 'memory.md')
  try {
    await fs.access(memory)
    return false // memory.md already exists; nothing to do
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  try {
    await fs.access(agents)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
  await fs.rename(agents, memory)
  return true
}

/**
 * Bootstrap seed-default env files into a fresh workspace's env/ dir.
 * Reads every `*.md` under
 * `seed-templates/workspaces/<kind>/` and writes any that don't already
 * exist. Idempotent — never overwrites user content.
 */
export async function seedDefaultEnvFiles(
  root: string,
  workspaceId: string,
  workspaceKind: string,
): Promise<string[]> {
  const tplDir = path.join(seedTemplatesRoot(), 'workspaces', workspaceKind)
  let entries: string[]
  try {
    entries = await fs.readdir(tplDir)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const written: string[] = []
  for (const name of entries) {
    if (!isValidEnvFileName(name)) continue
    const dest = path.join(workspaceEnvDir(root, workspaceId), name)
    try {
      await fs.access(dest)
      continue // already exists; preserve user edits
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    const content = await fs.readFile(path.join(tplDir, name), 'utf8')
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, content, 'utf8')
    written.push(name)
  }
  return written
}
