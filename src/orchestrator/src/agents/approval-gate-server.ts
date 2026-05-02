/**
 * Server-mode `beforeToolCall` gate. Replaces the CLI's TTY prompt with a
 * file-backed handshake suitable for HTTP clients.
 *
 * Flow:
 *   1. Tool call arrives. If non-bash or non-mutating → pass through.
 *   2. autoApprove / autoReject short-circuits like the CLI gate.
 *   3. Write `escalations/<urlEncodedToken>.json` with `{status: 'pending', toolCall, args}`.
 *   4. Emit `escalation_requested` on the bus (the SSE writer relays it
 *      to clients; the events persister writes it to events.jsonl).
 *   5. Poll the file at ~500ms cadence until `status` flips to `resolved`.
 *      Honors the AbortSignal so server shutdown / client disconnect
 *      doesn't hang the agent.
 *   6. Emit `escalation_resolved`. Translate decision → BeforeToolCallResult.
 *
 * Token format: `<sessionId>:<toolCallId>` (matches the spec). The file
 * name is `encodeURIComponent(token).json` so the `:` is URL-safe.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@mariozechner/pi-agent-core'
import type { SessionBus } from '../runtime/session-bus.js'
import { isMutating } from '../sandbox/mutating.js'
import { sessionEscalationsDir } from '../storage/paths.js'

export interface ServerApprovalGateOpts {
  dataRoot: string
  workspaceId: string
  teamName: string
  sessionId: string
  bus: SessionBus
  autoApprove?: boolean
  autoReject?: boolean
  /** Poll cadence in ms. Default 500. */
  pollIntervalMs?: number
}

interface PendingFile {
  token: string
  status: 'pending'
  toolCall: { id: string; name: string }
  args: unknown
}

interface ResolvedFile {
  token: string
  status: 'resolved'
  toolCall: { id: string; name: string }
  args: unknown
  decision: 'approve' | 'reject'
  message?: string
}

type EscalationFile = PendingFile | ResolvedFile

export function makeServerApprovalGate(
  opts: ServerApprovalGateOpts,
): (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  const pollMs = opts.pollIntervalMs ?? 500
  return async (ctx, signal) => {
    if (ctx.toolCall.name !== 'bash') return undefined
    const args = ctx.args as { command?: string; rationale?: string } | undefined
    const command = args?.command ?? ''
    if (!isMutating(command)) return undefined

    if (opts.autoApprove) return undefined
    if (opts.autoReject) return { block: true, reason: 'auto-reject mode' }

    const token = `${opts.sessionId}:${ctx.toolCall.id}`
    const dir = sessionEscalationsDir(opts.dataRoot, opts.workspaceId, opts.teamName, opts.sessionId)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${encodeURIComponent(token)}.json`)
    const pending: PendingFile = {
      token,
      status: 'pending',
      toolCall: { id: ctx.toolCall.id, name: ctx.toolCall.name },
      args: ctx.args,
    }
    await fs.writeFile(file, JSON.stringify(pending, null, 2), 'utf8')

    const prompt = `Approve mutating command?\n  $ ${command}${args?.rationale ? `\n  rationale: ${args.rationale}` : ''}`
    opts.bus.emit({
      kind: 'escalation_requested',
      token,
      payload: { prompt, details: { command, rationale: args?.rationale } },
      ts: Date.now(),
    })

    let resolved: ResolvedFile
    try {
      resolved = await pollForResolution(file, pollMs, signal)
    } catch (err) {
      // Aborted (server shutdown / client disconnect). Tell Pi to bail
      // out of this tool call. The session writer marks the run aborted.
      opts.bus.emit({
        kind: 'escalation_resolved',
        token,
        decision: 'reject',
        message: 'aborted',
        ts: Date.now(),
      })
      return { block: true, reason: 'Approval aborted (server shutdown or client disconnect).' }
    }

    opts.bus.emit({
      kind: 'escalation_resolved',
      token,
      decision: resolved.decision,
      message: resolved.message,
      ts: Date.now(),
    })

    if (resolved.decision === 'approve') return undefined
    return {
      block: true,
      reason: resolved.message ? `User rejected: ${resolved.message}` : 'User rejected this tool call.',
    }
  }
}

function pollForResolution(
  file: string,
  pollMs: number,
  signal?: AbortSignal,
): Promise<ResolvedFile> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null
    let cancelled = false
    const onAbort = () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error('aborted'))
    }
    if (signal) {
      if (signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const tick = async () => {
      if (cancelled) return
      try {
        const raw = await fs.readFile(file, 'utf8')
        const parsed = JSON.parse(raw) as EscalationFile
        if (parsed.status === 'resolved') {
          signal?.removeEventListener('abort', onAbort)
          resolve(parsed)
          return
        }
      } catch {
        // Mid-write or transient parse error — retry on next tick.
      }
      if (cancelled) return
      timer = setTimeout(tick, pollMs)
    }
    timer = setTimeout(tick, pollMs)
  })
}
