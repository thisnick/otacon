/**
 * `POST /api/v1/runs` — start (or resume) a session and stream OtaconEvents
 * back as SSE until the agent reaches a terminal state.
 *
 * The Hono route returns a `Response` whose body is a `ReadableStream`. The
 * stream's `start` callback constructs a fresh `Agent` + `SessionBus` +
 * tools per request and runs it inline. A bus subscriber is wired to push
 * each event onto the stream as `data: <json>\n\n`. After Pi emits
 * `agent_end` or `agent_error`, the writer enqueues `data: [DONE]\n\n`
 * and closes.
 *
 * The `x-orchestrator-session-id` response header is set via
 * `runSession`'s `onSessionResolved` callback; that callback fires before
 * any events are emitted (ulid is computed first), but Hono needs the
 * headers at construction time. Workaround: resolve the session id ahead
 * of time using the same logic as runtime/run.ts (resume/last/new), then
 * pass it through as a forced `resume` value so runtime is deterministic.
 *
 * Errors before the stream opens (bad workspace, kind mismatch, etc.) are
 * returned as 4xx JSON. Once the stream is open we commit to writing
 * `agent_error` events on failure rather than HTTP 5xx — matches the
 * spec's contract for mid-stream failures.
 */
import { Hono } from 'hono'
import { ulid } from 'ulid'
import { runSession } from '../../runtime/run.js'
import { readWorkspace } from '../../storage/workspace.js'
import { readTeam } from '../../storage/team.js'
import { readLastSessionId } from '../../storage/session.js'
import { makeServerApprovalGate } from '../../agents/approval-gate-server.js'
import type { OtaconEvent } from '../../types.js'
import { apiError } from '../errors.js'

export interface RunsContext {
  dataRoot: string
}

interface StartRunRequest {
  workspace?: string
  team?: string
  phone?: string
  userMessage?: string
  resume?: 'last' | 'new' | string
  autoApprove?: boolean
  autoReject?: boolean
  modelProvider?: string
}

export function makeRunsRoutes(ctx: RunsContext): Hono {
  const app = new Hono()

  app.post('/runs', async (c) => {
    let body: StartRunRequest
    try {
      body = await c.req.json<StartRunRequest>()
    } catch {
      return apiError(c, 'bad_request', 'request body must be valid JSON')
    }
    if (typeof body.workspace !== 'string' || !body.workspace) {
      return apiError(c, 'bad_request', 'missing required field "workspace"')
    }
    if (typeof body.team !== 'string' || !body.team) {
      return apiError(c, 'bad_request', 'missing required field "team"')
    }
    if (typeof body.userMessage !== 'string' || !body.userMessage) {
      return apiError(c, 'bad_request', 'missing required field "userMessage"')
    }
    if (typeof body.phone !== 'string' || !body.phone) {
      return apiError(c, 'bad_request', 'missing required field "phone"')
    }
    if (body.resume !== undefined &&
        body.resume !== 'last' &&
        body.resume !== 'new' &&
        typeof body.resume !== 'string') {
      return apiError(c, 'bad_request', 'invalid "resume" value')
    }

    // Pre-flight: resolve workspace + team here so 4xx errors don't leak
    // halfway into an open stream.
    const ws = await readWorkspace(ctx.dataRoot, body.workspace)
    if (!ws) {
      return apiError(c, 'workspace_not_found', `workspace "${body.workspace}" not found`, { workspaceId: body.workspace })
    }
    const team = await readTeam(ctx.dataRoot, body.team)
    if (!team) {
      return apiError(c, 'team_not_found', `team "${body.team}" not found`, { teamName: body.team })
    }
    if (team.expectedWorkspaceKind !== ws.kind) {
      return apiError(c, 'workspace_kind_mismatch',
        `team "${body.team}" expects workspace kind "${team.expectedWorkspaceKind}" but workspace "${ws.id}" is "${ws.kind}"`,
        { workspaceKind: ws.kind, expectedWorkspaceKind: team.expectedWorkspaceKind })
    }

    // Resolve session id up-front so we can set the response header before
    // the body opens. Mirrors runtime/run.ts logic.
    const resumeMode = body.resume ?? 'last'
    let resolvedSessionId: string
    if (resumeMode === 'new') {
      resolvedSessionId = ulid()
    } else if (resumeMode === 'last') {
      const last = await readLastSessionId(ctx.dataRoot, body.workspace, body.team)
      resolvedSessionId = last ?? ulid()
    } else {
      resolvedSessionId = resumeMode
    }

    // Stream wiring.
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const abortController = new AbortController()
        const signal = abortController.signal

        const writeEvent = (event: OtaconEvent) => {
          try {
            const line = JSON.stringify(event)
            controller.enqueue(encoder.encode(`data: ${line}\n\n`))
          } catch {
            // Some events may include non-serializable values (rare); skip.
          }
        }

        const writeDoneAndClose = () => {
          try { controller.enqueue(encoder.encode(`data: [DONE]\n\n`)) } catch {}
          try { controller.close() } catch {}
        }

        runSession({
          dataRoot: ctx.dataRoot,
          workspaceId: body.workspace!,
          teamName: body.team!,
          resume: resolvedSessionId, // forced; runtime treats as resume id
          userMessage: body.userMessage!,
          modelProvider: body.modelProvider,
          phoneClientBaseUrl: body.phone,
          autoApprove: body.autoApprove,
          autoReject: body.autoReject,
          silent: true,
          signal,
          extraSubscribers: [writeEvent],
          makeBeforeToolCall: (bus) => makeServerApprovalGate({
            dataRoot: ctx.dataRoot,
            workspaceId: body.workspace!,
            teamName: body.team!,
            sessionId: resolvedSessionId,
            bus,
            autoApprove: body.autoApprove,
            autoReject: body.autoReject,
          }),
        })
          .then(() => {
            writeDoneAndClose()
          })
          .catch((err) => {
            // Should be rare — runtime catches its own errors and writes
            // `agent_error`. This branch handles failures BEFORE the
            // agent loop starts (e.g. invalid model id).
            const msg = err instanceof Error ? err.message : String(err)
            writeEvent({
              kind: 'pi',
              event: { type: 'agent_error', error: msg } as never,
              ts: Date.now(),
            })
            writeDoneAndClose()
          })
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
        'x-orchestrator-session-id': resolvedSessionId,
      },
    })
  })

  return app
}
