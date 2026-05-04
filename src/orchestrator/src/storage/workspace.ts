/**
 * Workspace store — read/write `${dataRoot}/workspaces/<id>/workspace.json`.
 *
 * Phase I extends the spike's read-only helpers with full CRUD: create,
 * patch (via writeWorkspace), delete with optional cascade, and listing.
 *
 * Sibling artifacts (`credentials.json`, `env/`, `memory/`) are managed
 * by their own stores (env-files.ts, credentials.ts) and the seed script.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  workspaceDir,
  workspaceEnvDir,
  workspaceFile,
  workspaceMemoryDir,
} from './paths.js'
import type { Workspace } from '../types.js'

export async function readWorkspace(root: string, id: string): Promise<Workspace | null> {
  try {
    const raw = await fs.readFile(workspaceFile(root, id), 'utf8')
    return JSON.parse(raw) as Workspace
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export async function writeWorkspace(root: string, ws: Workspace): Promise<void> {
  await fs.mkdir(workspaceDir(root, ws.id), { recursive: true })
  await fs.writeFile(workspaceFile(root, ws.id), JSON.stringify(ws, null, 2), 'utf8')
}

/**
 * List all workspace ids on disk. Skips entries that aren't directories or
 * lack a `workspace.json`.
 */
export async function listWorkspaceIds(root: string): Promise<string[]> {
  const wsRoot = path.join(root, 'workspaces')
  let entries: string[]
  try {
    entries = await fs.readdir(wsRoot)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const out: string[] = []
  for (const id of entries) {
    try {
      const stat = await fs.stat(path.join(wsRoot, id))
      if (!stat.isDirectory()) continue
      await fs.access(workspaceFile(root, id))
      out.push(id)
    } catch {
      // skip unreadable / missing-config entries
    }
  }
  return out
}

/**
 * Number of session subdirectories across any team for this workspace.
 * Used by DELETE /workspaces/:id to refuse non-cascade delete when
 * sessions exist. Returns 0 if the workspace has no `teams/` dir at all.
 */
export async function countWorkspaceSessions(root: string, id: string): Promise<number> {
  const teamsRoot = path.join(workspaceDir(root, id), 'teams')
  let teamEntries: string[]
  try {
    teamEntries = await fs.readdir(teamsRoot)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw e
  }
  let count = 0
  for (const team of teamEntries) {
    const sessRoot = path.join(teamsRoot, team, 'sessions')
    try {
      const entries = await fs.readdir(sessRoot)
      for (const entry of entries) {
        try {
          const stat = await fs.stat(path.join(sessRoot, entry))
          if (stat.isDirectory()) count++
        } catch {
          // skip
        }
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  return count
}

/**
 * Recursively delete the workspace's entire on-disk directory. Caller
 * confirms user intent (cascade flag) at the API layer.
 */
export async function deleteWorkspace(root: string, id: string): Promise<void> {
  await fs.rm(workspaceDir(root, id), { recursive: true, force: true })
}

/**
 * Create the workspace dir layout: workspace.json + empty env/ + empty
 * memory/. Throws Error('workspace_already_exists') if a workspace.json
 * already exists at that id. Caller seeds env/*.md defaults afterward.
 */
export async function createWorkspaceLayout(
  root: string,
  ws: Workspace,
): Promise<void> {
  const existing = await readWorkspace(root, ws.id)
  if (existing) throw new Error('workspace_already_exists')
  await fs.mkdir(workspaceDir(root, ws.id), { recursive: true })
  await fs.mkdir(workspaceEnvDir(root, ws.id), { recursive: true })
  await fs.mkdir(workspaceMemoryDir(root, ws.id), { recursive: true })
  await fs.writeFile(workspaceFile(root, ws.id), JSON.stringify(ws, null, 2), 'utf8')
}
