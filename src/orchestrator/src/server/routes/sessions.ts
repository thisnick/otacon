/**
 * Session read routes.
 *
 *   GET /api/v1/workspaces/:w/teams/:t/sessions
 *   GET /api/v1/workspaces/:w/teams/:t/sessions/:sid
 *   GET /api/v1/workspaces/:w/teams/:t/sessions/:sid/events    (NDJSON or SSE)
 *   GET /api/v1/workspaces/:w/teams/:t/sessions/:sid/messages  (NDJSON)
 *   GET /api/v1/workspaces/:w/teams/:t/sessions/:sid/traces/:tcid/:file
 *
 * `events` has dual mode driven by `Accept`:
 *   - `text/event-stream`  → replay file as `data: <line>\n\n`, then tail
 *     the file for new appends until the session reaches a terminal status.
 *   - `application/x-ndjson` (or unset) → return the file as-is.
 *
 * The trace route serves `*.png` and `result.json` directly off disk with
 * `Cache-Control: private, max-age=86400` (immutable artifacts).
 */
import * as fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import * as path from 'node:path'
import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  sessionDir,
  sessionEventsFile,
  sessionMessagesFile,
  sessionTracesDir,
} from '../../storage/paths.js'
import { listSessions, readSessionMeta } from '../../storage/session.js'
import { readWorkspace } from '../../storage/workspace.js'
import { readTeam } from '../../storage/team.js'
import { apiError } from '../errors.js'

export interface SessionsContext {
  dataRoot: string
}

export function makeSessionsRoutes(ctx: SessionsContext): Hono {
  const app = new Hono()

  app.get('/workspaces/:workspace/teams/:team/sessions', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspace'))
    const teamName = decodeURIComponent(c.req.param('team'))
    const guard = await assertWorkspaceAndTeam(c, ctx.dataRoot, workspaceId, teamName)
    if (guard) return guard

    const ids = await listSessions(ctx.dataRoot, workspaceId, teamName)
    const summaries = []
    for (const id of ids) {
      const meta = await readSessionMeta(ctx.dataRoot, workspaceId, teamName, id)
      if (meta) summaries.push(meta)
    }
    summaries.sort((a, b) => b.startedAt - a.startedAt)
    return c.json(summaries)
  })

  app.get('/workspaces/:workspace/teams/:team/sessions/:sid', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspace'))
    const teamName = decodeURIComponent(c.req.param('team'))
    const sid = c.req.param('sid')
    const guard = await assertWorkspaceAndTeam(c, ctx.dataRoot, workspaceId, teamName)
    if (guard) return guard
    const meta = await readSessionMeta(ctx.dataRoot, workspaceId, teamName, sid)
    if (!meta) {
      return apiError(c, 'session_not_found', `session "${sid}" not found`, { sessionId: sid })
    }
    return c.json(meta)
  })

  app.get('/workspaces/:workspace/teams/:team/sessions/:sid/messages', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspace'))
    const teamName = decodeURIComponent(c.req.param('team'))
    const sid = c.req.param('sid')
    const guard = await assertSessionExists(c, ctx.dataRoot, workspaceId, teamName, sid)
    if (guard) return guard
    return streamFileAsNdjson(c, sessionMessagesFile(ctx.dataRoot, workspaceId, teamName, sid))
  })

  app.get('/workspaces/:workspace/teams/:team/sessions/:sid/events', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspace'))
    const teamName = decodeURIComponent(c.req.param('team'))
    const sid = c.req.param('sid')
    const guard = await assertSessionExists(c, ctx.dataRoot, workspaceId, teamName, sid)
    if (guard) return guard
    const accept = c.req.header('accept') ?? ''
    const wantsSse = accept.includes('text/event-stream')
    const file = sessionEventsFile(ctx.dataRoot, workspaceId, teamName, sid)
    if (wantsSse) {
      return streamEventsAsSse(c, ctx.dataRoot, workspaceId, teamName, sid, file)
    }
    return streamFileAsNdjson(c, file)
  })

  app.get('/workspaces/:workspace/teams/:team/sessions/:sid/traces/:tcid/:file', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspace'))
    const teamName = decodeURIComponent(c.req.param('team'))
    const sid = c.req.param('sid')
    const tcid = c.req.param('tcid')
    const fileParam = c.req.param('file')

    const allowed = new Set(['before.png', 'annotated.png', 'after.png', 'result.json'])
    if (!allowed.has(fileParam)) {
      return apiError(c, 'bad_request', `unsupported trace file "${fileParam}"`, { file: fileParam })
    }
    const guard = await assertSessionExists(c, ctx.dataRoot, workspaceId, teamName, sid)
    if (guard) return guard
    const dir = sessionTracesDir(ctx.dataRoot, workspaceId, teamName, sid)
    const filePath = path.join(dir, tcid, fileParam)
    if (!filePath.startsWith(dir + path.sep)) {
      return apiError(c, 'bad_request', 'invalid trace path', { tcid, file: fileParam })
    }
    let stat
    try {
      stat = await fs.stat(filePath)
    } catch {
      return apiError(c, 'session_not_found', `trace file "${fileParam}" not found`, { tcid, file: fileParam })
    }
    if (!stat.isFile()) {
      return apiError(c, 'bad_request', 'not a file', { tcid, file: fileParam })
    }
    const isPng = fileParam.endsWith('.png')
    const stream = nodeReadableToWeb(createReadStream(filePath))
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': isPng ? 'image/png' : 'application/json',
        'content-length': String(stat.size),
        'cache-control': 'private, max-age=86400',
      },
    })
  })

  return app
}

async function assertWorkspaceAndTeam(
  c: Context,
  dataRoot: string,
  workspaceId: string,
  teamName: string,
) {
  const ws = await readWorkspace(dataRoot, workspaceId)
  if (!ws) return apiError(c, 'workspace_not_found', `workspace "${workspaceId}" not found`, { workspaceId })
  const team = await readTeam(dataRoot, teamName)
  if (!team) return apiError(c, 'team_not_found', `team "${teamName}" not found`, { teamName })
  if (team.expectedWorkspaceKind !== ws.kind) {
    return apiError(c, 'workspace_kind_mismatch',
      `team "${teamName}" expects workspace kind "${team.expectedWorkspaceKind}" but workspace "${ws.id}" is "${ws.kind}"`,
      { workspaceKind: ws.kind, expectedWorkspaceKind: team.expectedWorkspaceKind })
  }
  return null
}

async function assertSessionExists(
  c: Context,
  dataRoot: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
) {
  const guard = await assertWorkspaceAndTeam(c, dataRoot, workspaceId, teamName)
  if (guard) return guard
  const dir = sessionDir(dataRoot, workspaceId, teamName, sessionId)
  try {
    const stat = await fs.stat(dir)
    if (!stat.isDirectory()) {
      return apiError(c, 'session_not_found', `session "${sessionId}" not found`, { sessionId })
    }
  } catch {
    return apiError(c, 'session_not_found', `session "${sessionId}" not found`, { sessionId })
  }
  return null
}

async function streamFileAsNdjson(
  c: Context,
  file: string,
) {
  let stat
  try {
    stat = await fs.stat(file)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Response('', {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      })
    }
    throw e
  }
  const stream = nodeReadableToWeb(createReadStream(file))
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-length': String(stat.size),
    },
  })
}

async function streamEventsAsSse(
  c: Context,
  dataRoot: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
  file: string,
) {
  const encoder = new TextEncoder()
  let abortController: AbortController | null = null
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      abortController = new AbortController()
      const signal = abortController.signal

      const closeWithDone = () => {
        try { controller.enqueue(encoder.encode(`data: [DONE]\n\n`)) } catch {}
        try { controller.close() } catch {}
      }

      // Replay everything currently on disk, line by line.
      let cursor = 0
      try {
        const raw = await fs.readFile(file, 'utf8')
        cursor = Buffer.byteLength(raw, 'utf8')
        for (const line of raw.split('\n')) {
          if (signal.aborted) return
          if (!line) continue
          controller.enqueue(encoder.encode(`data: ${line}\n\n`))
        }
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          controller.error(e)
          return
        }
        // No file yet — start tailing from offset 0.
      }

      // If session is already terminal, close after replay.
      const meta = await readSessionMeta(dataRoot, workspaceId, teamName, sessionId)
      if (meta && meta.status !== 'running') {
        closeWithDone()
        return
      }

      // Tail the file. Every 500ms re-stat; if size grew, read the delta.
      const TICK_MS = 500
      let stopped = false
      const stop = () => {
        stopped = true
      }
      signal.addEventListener('abort', stop)

      while (!stopped && !signal.aborted) {
        await sleep(TICK_MS)
        if (stopped || signal.aborted) break
        try {
          const stat = await fs.stat(file)
          if (stat.size > cursor) {
            const fh = await fs.open(file, 'r')
            try {
              const len = stat.size - cursor
              const buf = Buffer.alloc(len)
              await fh.read(buf, 0, len, cursor)
              cursor = stat.size
              const text = buf.toString('utf8')
              for (const line of text.split('\n')) {
                if (!line) continue
                controller.enqueue(encoder.encode(`data: ${line}\n\n`))
              }
            } finally {
              await fh.close()
            }
          }
        } catch {
          // file may not exist yet — keep waiting
        }
        // Check terminal status periodically.
        const m = await readSessionMeta(dataRoot, workspaceId, teamName, sessionId)
        if (m && m.status !== 'running') {
          closeWithDone()
          return
        }
      }
      closeWithDone()
    },
    cancel() {
      abortController?.abort()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: sseHeaders(),
  })
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  }
}

function nodeReadableToWeb(node: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      node.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
      })
      node.on('end', () => controller.close())
      node.on('error', err => controller.error(err))
    },
    cancel() {
      // best effort
      const r = node as { destroy?: () => void }
      r.destroy?.()
    },
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
