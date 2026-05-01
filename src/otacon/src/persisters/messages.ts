/**
 * messages.jsonl persister — appends Pi's native `Message[]` artifacts so
 * a future run can `agent.continue()` from the saved transcript.
 *
 * Subscribes to `OtaconEvent` of `kind: 'pi'` with inner type `message_end`
 * (assistant turn finished) and `tool_execution_end` (tool result ready).
 * Both produce a fully-formed `Message` shape that we want to round-trip.
 *
 * Pi's `agent_end` event includes the final `messages: AgentMessage[]`,
 * but we append per-event so a crash mid-run doesn't lose the partial
 * transcript.
 */
import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core'
import type { Message } from '@mariozechner/pi-ai'
import { appendMessage } from '../storage/session.js'
import type { OtaconEvent } from '../types.js'
import type { Listener } from '../runtime/session-bus.js'

export interface MessagesPersisterOpts {
  dataRoot: string
  workspaceId: string
  teamName: string
  sessionId: string
}

/**
 * Build a SessionBus listener that writes one Message per relevant event.
 *
 * Async fire-and-forget under the hood — the bus's `emit` is sync so we
 * spawn the append without awaiting; an outer try/catch logs failures.
 */
export function makeMessagesPersister(opts: MessagesPersisterOpts): Listener {
  const { dataRoot, workspaceId, teamName, sessionId } = opts
  return (event: OtaconEvent) => {
    if (event.kind !== 'pi') return
    const piEvent = event.event
    const msg = extractMessage(piEvent)
    if (!msg) return
    appendMessage(dataRoot, workspaceId, teamName, sessionId, msg).catch(err => {
      console.error('[messages-persister] append failed:', err)
    })
  }
}

function extractMessage(piEvent: AgentEvent): Message | null {
  if (piEvent.type === 'message_end') {
    return toMessage(piEvent.message)
  }
  // turn_end carries tool results from this turn; emit each as a separate
  // jsonl line so the transcript is canonical and complete.
  if (piEvent.type === 'turn_end') {
    // tool results are written via separate message_end events for the
    // tool-result messages, so don't double-write here. Leaving this
    // branch unhandled is intentional.
    return null
  }
  return null
}

function toMessage(m: AgentMessage): Message | null {
  if (
    m && typeof m === 'object' &&
    'role' in m &&
    (m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult')
  ) {
    return m as Message
  }
  // Custom AgentMessages (notification / artifact) aren't LLM messages —
  // they're filtered by convertToLlm at run time. Skip in messages.jsonl
  // so resume's `agent.continue()` doesn't see types it can't replay.
  return null
}
