/**
 * `escalate` Pi tool — agent calls when it needs human input.
 *
 * Writes `escalations/<token>.json = {token, payload, status: 'pending'}`,
 * emits `escalation_requested` event, polls every 1s for status change,
 * returns the human's payload as content.
 *
 * Token format: `<sessionId>:<turn>:<toolCallId>`. The simpler
 * `<toolCallId>` would also work for spike since toolCallId is unique
 * across the run.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Type } from 'typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { SessionBus } from '../runtime/session-bus.js'
import { sessionEscalationsDir } from '../storage/paths.js'

export interface EscalateToolOpts {
  dataRoot: string
  workspaceId: string
  teamName: string
  sessionId: string
  bus: SessionBus
  /** Poll interval ms. Default 1000. */
  pollIntervalMs?: number
  /** Optional abort signal (resolves with rejection). */
  signal?: AbortSignal
}

interface PendingFile {
  token: string
  payload: { prompt: string; details?: unknown }
  status: 'pending'
}

interface ResolvedFile {
  token: string
  payload: { prompt: string; details?: unknown }
  status: 'resolved'
  decision: 'approve' | 'reject'
  message?: string
}

type EscalationFile = PendingFile | ResolvedFile

const EscalateSchema = Type.Object({
  prompt: Type.String({ description: 'Question or request directed at the human user.' }),
  details: Type.Optional(Type.Any({ description: 'Optional supporting context (object/array/string).' })),
})

export function makeEscalateTool(opts: EscalateToolOpts): AgentTool<typeof EscalateSchema, { token: string; decision: string; message?: string }> {
  const pollMs = opts.pollIntervalMs ?? 1000
  return {
    name: 'escalate',
    label: 'Escalate to human',
    description:
      'Pause and ask the human for guidance, approval, or additional context. The agent halts until the human responds.',
    parameters: EscalateSchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal): Promise<AgentToolResult<{ token: string; decision: string; message?: string }>> {
      const token = `${opts.sessionId}:${toolCallId}`
      const dir = sessionEscalationsDir(opts.dataRoot, opts.workspaceId, opts.teamName, opts.sessionId)
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${encodeURIComponent(token)}.json`)
      const pending: PendingFile = { token, payload: { prompt: params.prompt, details: params.details }, status: 'pending' }
      await fs.writeFile(file, JSON.stringify(pending, null, 2), 'utf8')

      opts.bus.emit({
        kind: 'escalation_requested',
        token,
        payload: { prompt: params.prompt, details: params.details },
        ts: Date.now(),
      })

      const effectiveSignal = signal ?? opts.signal
      const resolved = await pollForResolution(file, pollMs, effectiveSignal)
      opts.bus.emit({
        kind: 'escalation_resolved',
        token,
        decision: resolved.decision,
        message: resolved.message,
        ts: Date.now(),
      })

      const text = resolved.decision === 'approve'
        ? `User approved.${resolved.message ? ` Message: ${resolved.message}` : ''}`
        : `User rejected.${resolved.message ? ` Message: ${resolved.message}` : ''}`
      return {
        content: [{ type: 'text', text }],
        details: { token, decision: resolved.decision, message: resolved.message },
      }
    },
  }
}

async function pollForResolution(file: string, pollMs: number, signal?: AbortSignal): Promise<ResolvedFile> {
  while (true) {
    if (signal?.aborted) {
      throw new Error('escalate: aborted by signal')
    }
    try {
      const raw = await fs.readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as EscalationFile
      if (parsed.status === 'resolved') return parsed
    } catch (e) {
      // file might be mid-write; ignore parse / read errors and try again
    }
    await sleepWithSignal(pollMs, signal)
  }
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => {
        clearTimeout(t)
        signal.removeEventListener('abort', onAbort)
        reject(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
