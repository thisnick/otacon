/**
 * Workspace + team read+write routes (Phase I).
 *
 * Existing read endpoints (Phase B):
 *   GET    /api/v1/workspaces
 *   GET    /api/v1/workspaces/:workspace/teams
 *
 * Phase I additions — workspace CRUD:
 *   POST   /api/v1/workspaces
 *   GET    /api/v1/workspaces/:id
 *   PATCH  /api/v1/workspaces/:id
 *   DELETE /api/v1/workspaces/:id[?force=true]
 *
 * Env files (per-workspace markdown context):
 *   GET    /api/v1/workspaces/:id/env
 *   GET    /api/v1/workspaces/:id/env/:file       (text/markdown)
 *   PUT    /api/v1/workspaces/:id/env/:file       (text/markdown body)
 *   DELETE /api/v1/workspaces/:id/env/:file
 *   POST   /api/v1/workspaces/:id/env/:file/reset (revert to seed default)
 *
 * Credentials (write-only, never returned):
 *   GET    /api/v1/workspaces/:id/credentials     ({hasCredentials, fieldsSet})
 *   PUT    /api/v1/workspaces/:id/credentials     (opaque JSON body)
 *   DELETE /api/v1/workspaces/:id/credentials
 *
 * Walks the on-disk file tree (`${dataRoot}/workspaces/*`) directly. No
 * in-memory cache. Storage helpers live in src/storage/.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  countWorkspaceSessions,
  createWorkspaceLayout,
  deleteWorkspace,
  listWorkspaceIds,
  readWorkspace,
  writeWorkspace,
} from '../../storage/workspace.js'
import { listTeamNames, readTeam } from '../../storage/team.js'
import {
  deleteEnvFile,
  isValidEnvFileName,
  listEnvFiles,
  migrateAgentsToMemory,
  readEnvFile,
  readEnvFileDefault,
  seedDefaultEnvFiles,
  writeEnvFile,
} from '../../storage/env-files.js'
import {
  deleteCredentials,
  readCredentialsStatus,
  writeCredentials,
} from '../../storage/credentials.js'
import type { Workspace, Team } from '../../types.js'
import { apiError } from '../errors.js'

export interface WorkspacesContext {
  dataRoot: string
}

// E.164: '+' followed by 7-15 digits, leading digit 1-9.
const E164_PATTERN = /^\+[1-9]\d{6,14}$/

// Workspace id format: "kind:identifier" with [a-zA-Z0-9_-]+ on each side.
// Identifier may also contain `.`. Matches the seeded id `xhs:test`.
const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]+:[a-zA-Z0-9._-]+$/

interface CreateWorkspaceBody {
  id?: unknown
  displayName?: unknown
  kind?: unknown
  phoneNumber?: unknown
  externalRef?: unknown
}

interface PatchWorkspaceBody {
  displayName?: unknown
  kind?: unknown
  phoneNumber?: unknown
  externalRef?: unknown
}

export function makeWorkspacesRoutes(ctx: WorkspacesContext): Hono {
  const app = new Hono()

  // ---------------------------------------------------------------------------
  // Workspaces — list + create
  // ---------------------------------------------------------------------------

  app.get('/workspaces', async (c) => {
    const list = await listWorkspaces(ctx.dataRoot)
    list.sort((a, b) => a.id.localeCompare(b.id))
    return c.json(list)
  })

  app.post('/workspaces', async (c) => {
    let body: CreateWorkspaceBody
    try {
      body = await c.req.json<CreateWorkspaceBody>()
    } catch {
      return apiError(c, 'bad_request', 'request body must be valid JSON')
    }
    const { id, displayName, kind, phoneNumber, externalRef } = body
    if (typeof id !== 'string' || id.length === 0) {
      return apiError(c, 'bad_request', 'missing required field "id"')
    }
    if (!WORKSPACE_ID_PATTERN.test(id)) {
      return apiError(c, 'bad_request',
        `invalid workspace id "${id}" — must match "kind:identifier" using [a-zA-Z0-9_-]`,
        { id })
    }
    if (typeof displayName !== 'string' || displayName.length === 0) {
      return apiError(c, 'bad_request', 'missing required field "displayName"')
    }
    if (typeof kind !== 'string' || kind.length === 0) {
      return apiError(c, 'bad_request', 'missing required field "kind"')
    }
    if (typeof phoneNumber !== 'string' || phoneNumber.length === 0) {
      return apiError(c, 'bad_request', 'missing required field "phoneNumber"')
    }
    if (!E164_PATTERN.test(phoneNumber)) {
      return apiError(c, 'bad_request',
        `invalid phoneNumber "${phoneNumber}" — must be E.164 format (+1234567890)`,
        { phoneNumber })
    }
    if (externalRef !== undefined && typeof externalRef !== 'string') {
      return apiError(c, 'bad_request', '"externalRef" must be a string when provided')
    }

    const ws: Workspace = {
      id,
      displayName,
      kind,
      phoneNumber,
      ...(externalRef !== undefined ? { externalRef } : {}),
      createdAt: Date.now(),
    }
    try {
      await createWorkspaceLayout(ctx.dataRoot, ws)
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'workspace_already_exists') {
        return apiError(c, 'workspace_already_exists',
          `workspace "${id}" already exists`, { id })
      }
      throw e
    }
    // Seed default env files for this kind. Best-effort — if the kind
    // has no template tree we still create the workspace successfully.
    try {
      await seedDefaultEnvFiles(ctx.dataRoot, id, kind)
    } catch (err) {
      console.error(`[workspaces] failed to seed env files for ${id}/${kind}:`, err)
    }
    return c.json(ws, 201)
  })

  // ---------------------------------------------------------------------------
  // Workspaces — single get / patch / delete
  // ---------------------------------------------------------------------------

  app.get('/workspaces/:id', async (c) => {
    const id = decodeURIComponent(c.req.param('id'))
    const ws = await readWorkspace(ctx.dataRoot, id)
    if (!ws) return notFoundWs(c, id)
    return c.json(ws)
  })

  app.patch('/workspaces/:id', async (c) => {
    const id = decodeURIComponent(c.req.param('id'))
    const ws = await readWorkspace(ctx.dataRoot, id)
    if (!ws) return notFoundWs(c, id)
    let body: PatchWorkspaceBody
    try {
      body = await c.req.json<PatchWorkspaceBody>()
    } catch {
      return apiError(c, 'bad_request', 'request body must be valid JSON')
    }
    const next: Workspace = { ...ws }
    if (body.displayName !== undefined) {
      if (typeof body.displayName !== 'string' || body.displayName.length === 0) {
        return apiError(c, 'bad_request', '"displayName" must be a non-empty string')
      }
      next.displayName = body.displayName
    }
    if (body.kind !== undefined) {
      if (typeof body.kind !== 'string' || body.kind.length === 0) {
        return apiError(c, 'bad_request', '"kind" must be a non-empty string')
      }
      next.kind = body.kind
    }
    if (body.phoneNumber !== undefined) {
      if (typeof body.phoneNumber !== 'string' || !E164_PATTERN.test(body.phoneNumber)) {
        return apiError(c, 'bad_request',
          `invalid phoneNumber "${String(body.phoneNumber)}" — must be E.164 format`,
          { phoneNumber: body.phoneNumber })
      }
      next.phoneNumber = body.phoneNumber
    }
    if (body.externalRef !== undefined) {
      if (body.externalRef === null || body.externalRef === '') {
        delete next.externalRef
      } else if (typeof body.externalRef !== 'string') {
        return apiError(c, 'bad_request', '"externalRef" must be a string when provided')
      } else {
        next.externalRef = body.externalRef
      }
    }
    await writeWorkspace(ctx.dataRoot, next)
    return c.json(next)
  })

  app.delete('/workspaces/:id', async (c) => {
    const id = decodeURIComponent(c.req.param('id'))
    const ws = await readWorkspace(ctx.dataRoot, id)
    if (!ws) return notFoundWs(c, id)
    const force = c.req.query('force') === 'true'
    if (!force) {
      const sessions = await countWorkspaceSessions(ctx.dataRoot, id)
      if (sessions > 0) {
        return apiError(c, 'workspace_has_sessions',
          `workspace "${id}" has ${sessions} session(s); use ?force=true to cascade-delete`,
          { id, sessions })
      }
    }
    await deleteWorkspace(ctx.dataRoot, id)
    return c.body(null, 204)
  })

  // ---------------------------------------------------------------------------
  // Env files
  // ---------------------------------------------------------------------------

  app.get('/workspaces/:id/env', async (c) => {
    const id = decodeURIComponent(c.req.param('id'))
    const ws = await readWorkspace(ctx.dataRoot, id)
    if (!ws) return notFoundWs(c, id)
    try { await migrateAgentsToMemory(ctx.dataRoot, id) } catch {}
    const list = await listEnvFiles(ctx.dataRoot, id)
    return c.json(list)
  })

  app.get('/workspaces/:id/env/:file', async (c) => {
    const id = decodeURIComponent(c.req.param('id'))
    const file = decodeURIComponent(c.req.param('file'))
    const ws = await readWorkspace(ctx.dataRoot, id)
    if (!ws) return notFoundWs(c, id)
    if (!isValidEnvFileName(file)) {
      return apiError(c, 'bad_request', `invalid env file name "${file}"`, { file })
    }
    try { await migrateAgentsToMemory(ctx.dataRoot, id) } catch {}
    const content = await readEnvFile(ctx.dataRoot, id, file)
    if (content === null) {
      return apiError(c, 'env_file_not_found',
        `env file "${file}" not found in workspace "${id}"`, { id, file })
    }
    return new Response(content, {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    })
  })

  app.put('/workspaces/:id/env/:file', async (c) => {
    const id = decodeURIComponent(c.req.param('id'))
    const file = decodeURIComponent(c.req.param('file'))
    const ws = await readWorkspace(ctx.dataRoot, id)
    if (!ws) return notFoundWs(c, id)
    if (!isValidEnvFileName(file)) {
      return apiError(c, 'bad_request', `invalid env file name "${file}"`, { file })
    }
    const content = await c.req.text()
    await writeEnvFile(ctx.dataRoot, id, file, content)
    return c.body(null, 204)
  })

  app.delete('/workspaces/:id/env/:file', async (c) => {
    const id = decodeURIComponent(c.req.param('id'))
    const file = decodeURIComponent(c.req.param('file'))
    const ws = await readWorkspace(ctx.dataRoot, id)
    if (!ws) return notFoundWs(c, id)
    if (!isValidEnvFileName(file)) {
      return apiError(c, 'bad_request', `invalid env file name "${file}"`, { file })
    }
    const deleted = await deleteEnvFile(ctx.dataRoot, id, file)
    if (!deleted) {
      return apiError(c, 'env_file_not_found',
        `env file "${file}" not found in workspace "${id}"`, { id, file })
    }
    return c.body(null, 204)
  })

  app.post('/workspaces/:id/env/:file/reset', async (c) => {
    const id = decodeURIComponent(c.req.param('id'))
    const file = decodeURIComponent(c.req.param('file'))
    const ws = await readWorkspace(ctx.dataRoot, id)
    if (!ws) return notFoundWs(c, id)
    if (!isValidEnvFileName(file)) {
      return apiError(c, 'bad_request', `invalid env file name "${file}"`, { file })
    }
    const def = await readEnvFileDefault(ws.kind, file)
    if (def === null) {
      return apiError(c, 'no_default_for_file',
        `no seed-default exists for env file "${file}" under kind "${ws.kind}"`,
        { file, kind: ws.kind })
    }
    await writeEnvFile(ctx.dataRoot, id, file, def)
    return new Response(def, {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    })
  })

  // ---------------------------------------------------------------------------
  // Credentials (write-only)
  // ---------------------------------------------------------------------------

  app.get('/workspaces/:id/credentials', async (c) => {
    const id = decodeURIComponent(c.req.param('id'))
    const ws = await readWorkspace(ctx.dataRoot, id)
    if (!ws) return notFoundWs(c, id)
    const status = await readCredentialsStatus(ctx.dataRoot, id)
    return c.json(status)
  })

  app.put('/workspaces/:id/credentials', async (c) => {
    const id = decodeURIComponent(c.req.param('id'))
    const ws = await readWorkspace(ctx.dataRoot, id)
    if (!ws) return notFoundWs(c, id)
    let body: unknown
    try {
      body = await c.req.json<unknown>()
    } catch {
      return apiError(c, 'bad_request', 'credentials body must be valid JSON')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return apiError(c, 'bad_request', 'credentials body must be a JSON object')
    }
    await writeCredentials(ctx.dataRoot, id, body)
    return c.body(null, 204)
  })

  app.delete('/workspaces/:id/credentials', async (c) => {
    const id = decodeURIComponent(c.req.param('id'))
    const ws = await readWorkspace(ctx.dataRoot, id)
    if (!ws) return notFoundWs(c, id)
    await deleteCredentials(ctx.dataRoot, id)
    return c.body(null, 204)
  })

  // ---------------------------------------------------------------------------
  // Teams listing scoped to workspace (existing)
  // ---------------------------------------------------------------------------

  app.get('/workspaces/:workspace/teams', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspace'))
    const ws = await readWorkspace(ctx.dataRoot, workspaceId)
    if (!ws) return notFoundWs(c, workspaceId)
    const teams = await listTeams(ctx.dataRoot)
    const compatible = teams
      .filter(t => t.expectedWorkspaceKind === ws.kind)
      .sort((a, b) => a.name.localeCompare(b.name))
    return c.json(compatible)
  })

  return app
}

function notFoundWs(c: Context, workspaceId: string) {
  return apiError(c, 'workspace_not_found',
    `workspace "${workspaceId}" not found`, { workspaceId })
}

async function listWorkspaces(dataRoot: string): Promise<Workspace[]> {
  const ids = await listWorkspaceIds(dataRoot)
  const out: Workspace[] = []
  for (const id of ids) {
    try {
      const ws = await readWorkspace(dataRoot, id)
      if (ws) out.push(ws)
    } catch {
      // skip unreadable workspace
    }
  }
  return out
}

async function listTeams(dataRoot: string): Promise<Team[]> {
  const names = await listTeamNames(dataRoot)
  const out: Team[] = []
  for (const name of names) {
    const t = await readTeam(dataRoot, name)
    if (t) out.push(t)
  }
  return out
}
