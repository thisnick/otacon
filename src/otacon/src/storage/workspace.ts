/**
 * Workspace store — read/write `.otacon-data/workspaces/<id>/workspace.json`.
 *
 * The on-disk shape is the same as the `Workspace` type in src/types.ts.
 * `credentials.json`, `env/`, `memory/` are sibling artifacts the spike
 * doesn't manage explicitly — the seed script populates them; the agent
 * sandbox links to env/memory.
 */
import * as fs from 'node:fs/promises'
import { workspaceDir, workspaceFile } from './paths.js'
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
