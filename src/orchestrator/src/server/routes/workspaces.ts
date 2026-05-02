/**
 * Workspace + team read routes.
 *
 *   GET /api/v1/workspaces                                — list workspaces
 *   GET /api/v1/workspaces/:workspace/teams               — list teams compatible with this workspace's kind
 *
 * Walks the on-disk file tree (`${dataRoot}/workspaces/*` and
 * `${dataRoot}/teams/*`). No in-memory cache — small data volume; revisit
 * if it grows.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Hono } from 'hono'
import { workspaceFile } from '../../storage/paths.js'
import { readWorkspace } from '../../storage/workspace.js'
import { readTeam } from '../../storage/team.js'
import type { Workspace, Team } from '../../types.js'
import { apiError } from '../errors.js'

export interface WorkspacesContext {
  dataRoot: string
}

export function makeWorkspacesRoutes(ctx: WorkspacesContext): Hono {
  const app = new Hono()

  app.get('/workspaces', async (c) => {
    const list = await listWorkspaces(ctx.dataRoot)
    list.sort((a, b) => a.id.localeCompare(b.id))
    return c.json(list)
  })

  app.get('/workspaces/:workspace/teams', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspace'))
    const ws = await readWorkspace(ctx.dataRoot, workspaceId)
    if (!ws) {
      return apiError(c, 'workspace_not_found', `workspace "${workspaceId}" not found`, { workspaceId })
    }
    const teams = await listTeams(ctx.dataRoot)
    const compatible = teams
      .filter(t => t.expectedWorkspaceKind === ws.kind)
      .sort((a, b) => a.name.localeCompare(b.name))
    return c.json(compatible)
  })

  return app
}

async function listWorkspaces(dataRoot: string): Promise<Workspace[]> {
  const wsRoot = path.join(dataRoot, 'workspaces')
  let entries: string[]
  try {
    entries = await fs.readdir(wsRoot)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const out: Workspace[] = []
  for (const id of entries) {
    try {
      const stat = await fs.stat(path.join(wsRoot, id))
      if (!stat.isDirectory()) continue
      const exists = await fileExists(workspaceFile(dataRoot, id))
      if (!exists) continue
      const ws = await readWorkspace(dataRoot, id)
      if (ws) out.push(ws)
    } catch {
      // skip unreadable workspace
    }
  }
  return out
}

async function listTeams(dataRoot: string): Promise<Team[]> {
  const teamsRoot = path.join(dataRoot, 'teams')
  let entries: string[]
  try {
    entries = await fs.readdir(teamsRoot)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const out: Team[] = []
  for (const name of entries) {
    try {
      const stat = await fs.stat(path.join(teamsRoot, name))
      if (!stat.isDirectory()) continue
      const team = await readTeam(dataRoot, name)
      if (team) out.push(team)
    } catch {
      // skip unreadable team
    }
  }
  return out
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
