/**
 * `POST /api/v1/escalations/:token/resolve` — resolve a pending escalation
 * by rewriting the on-disk file from `{status: 'pending'}` to
 * `{status: 'resolved', decision, message}`.
 *
 * Token format is `<sessionId>:<toolCallId>`. The path parameter is
 * URL-encoded; we decode, then re-encode for the filename so the on-disk
 * encoding matches what the gate / escalate tool wrote.
 *
 * Search strategy: the file lives at
 *   ${dataRoot}/workspaces/<ws>/teams/<team>/sessions/<sid>/escalations/<urlEncodedToken>.json
 * but the route only knows the token. We extract `sessionId` from the
 * token and walk every workspace+team to find the matching session
 * directory. Cheap: small fan-out and the request is rare.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Hono } from 'hono'
import { sessionEscalationsDir } from '../../storage/paths.js'
import { apiError } from '../errors.js'

export interface EscalationsContext {
  dataRoot: string
}

interface ResolveBody {
  decision?: 'approve' | 'reject'
  message?: string
}

interface PendingFile {
  token: string
  status: 'pending'
  toolCall: { id: string; name: string }
  args: unknown
  payload?: unknown
}

interface ResolvedFile {
  token: string
  status: 'resolved'
  toolCall?: { id: string; name: string }
  args?: unknown
  payload?: unknown
  decision: 'approve' | 'reject'
  message?: string
}

export function makeEscalationsRoutes(ctx: EscalationsContext): Hono {
  const app = new Hono()

  app.post('/escalations/:token/resolve', async (c) => {
    const token = decodeURIComponent(c.req.param('token'))
    let body: ResolveBody
    try {
      body = await c.req.json<ResolveBody>()
    } catch {
      return apiError(c, 'bad_request', 'request body must be valid JSON')
    }
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      return apiError(c, 'bad_request', 'decision must be "approve" or "reject"', { received: body.decision })
    }
    if (body.message !== undefined && typeof body.message !== 'string') {
      return apiError(c, 'bad_request', 'message must be a string when provided')
    }

    const sessionId = token.split(':')[0] ?? ''
    if (!sessionId) {
      return apiError(c, 'bad_request', 'invalid token (missing session id)', { token })
    }

    const file = await locateEscalationFile(ctx.dataRoot, sessionId, token)
    if (!file) {
      return apiError(c, 'escalation_not_found', `no pending escalation for token "${token}"`, { token })
    }

    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      return apiError(c, 'escalation_not_found', `escalation file unreadable for token "${token}"`, { token })
    }
    let parsed: PendingFile | ResolvedFile
    try {
      parsed = JSON.parse(raw) as PendingFile | ResolvedFile
    } catch {
      return apiError(c, 'internal', 'escalation file is not valid JSON', { token })
    }
    if (parsed.status === 'resolved') {
      return apiError(c, 'escalation_already_resolved', `escalation "${token}" already resolved`, { token })
    }

    const resolved: ResolvedFile = {
      token: parsed.token,
      status: 'resolved',
      toolCall: parsed.toolCall,
      args: parsed.args,
      payload: parsed.payload,
      decision: body.decision,
      message: body.message,
    }
    await fs.writeFile(file, JSON.stringify(resolved, null, 2), 'utf8')
    return c.body(null, 200)
  })

  return app
}

/**
 * Walks every workspace+team to find the escalation file for `sessionId`.
 * Two-deep glob: workspaces/*\/teams/*\/sessions/<sid>/escalations/<encodedToken>.json
 */
async function locateEscalationFile(
  dataRoot: string,
  sessionId: string,
  token: string,
): Promise<string | null> {
  const wsRoot = path.join(dataRoot, 'workspaces')
  let wsEntries: string[]
  try {
    wsEntries = await fs.readdir(wsRoot)
  } catch {
    return null
  }
  for (const ws of wsEntries) {
    const teamsRoot = path.join(wsRoot, ws, 'teams')
    let teamEntries: string[]
    try {
      teamEntries = await fs.readdir(teamsRoot)
    } catch {
      continue
    }
    for (const team of teamEntries) {
      const sessionsRoot = path.join(teamsRoot, team, 'sessions')
      try {
        const sessionStat = await fs.stat(path.join(sessionsRoot, sessionId))
        if (!sessionStat.isDirectory()) continue
      } catch {
        continue
      }
      const dir = sessionEscalationsDir(dataRoot, ws, team, sessionId)
      const file = path.join(dir, `${encodeURIComponent(token)}.json`)
      try {
        await fs.access(file)
        return file
      } catch {
        // not in this session's escalations dir
      }
    }
  }
  return null
}
