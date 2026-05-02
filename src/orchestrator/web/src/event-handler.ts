// Reduces an OtaconEvent stream into a transcript view-model.
//
// The view-model is a chronological list of items keyed by ts. Two kinds:
//   - 'message': an AgentMessage from a `pi` event (message_end / agent_end)
//   - 'card': a custom OtaconEvent rendered as an inline card (phone_action,
//             escalation_requested → resolved).
//
// Plus a single transient "streaming message" that updates on message_update
// and gets cleared when message_end lands.

import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type {
  EscalationPayload,
  OtaconEvent,
  PhoneActionPayload,
} from './types.js'

export type EscalationStatus = 'pending' | 'resolved'

export interface EscalationCardState {
  token: string
  payload: EscalationPayload
  status: EscalationStatus
  decision?: 'approve' | 'reject'
  resolutionMessage?: string
  ts: number
}

export type TranscriptItem =
  | { kind: 'message'; ts: number; message: AgentMessage }
  | { kind: 'phone_action'; ts: number; payload: PhoneActionPayload }
  | { kind: 'escalation'; ts: number; state: EscalationCardState }
  | { kind: 'system'; ts: number; prompt: string }
  | { kind: 'user_text'; ts: number; text: string }

export interface TranscriptState {
  items: TranscriptItem[]
  streamingMessage: AgentMessage | null
  isStreaming: boolean
  isTerminal: boolean
  terminalKind?: 'agent_end' | 'agent_error'
}

export type StateListener = (state: TranscriptState) => void

export class TranscriptStore {
  private state: TranscriptState = {
    items: [],
    streamingMessage: null,
    isStreaming: false,
    isTerminal: false,
  }
  private listeners = new Set<StateListener>()
  // Keys keyed-on (item identity) so we can update in place.
  // For escalations: token; for messages: we just append, no dedup.
  private escalationIndex = new Map<string, number>()

  subscribe(fn: StateListener): () => void {
    this.listeners.add(fn)
    fn(this.state)
    return () => this.listeners.delete(fn)
  }

  getState(): TranscriptState {
    return this.state
  }

  reset(): void {
    this.state = {
      items: [],
      streamingMessage: null,
      isStreaming: false,
      isTerminal: false,
    }
    this.escalationIndex.clear()
    this.emit()
  }

  ingest(ev: OtaconEvent): void {
    switch (ev.kind) {
      case 'system_set':
        this.append({ kind: 'system', ts: ev.ts, prompt: ev.prompt })
        break
      case 'user_message':
        // The orchestrator also persists user messages as `pi.message_end`
        // events with role=user. MessageList renders those, so emitting a
        // `user_text` card here would duplicate the bubble. Skip.
        break
      case 'phone_action':
        this.append({ kind: 'phone_action', ts: ev.ts, payload: ev.payload })
        break
      case 'escalation_requested': {
        const state: EscalationCardState = {
          token: ev.token,
          payload: ev.payload,
          status: 'pending',
          ts: ev.ts,
        }
        const idx = this.state.items.length
        this.escalationIndex.set(ev.token, idx)
        this.append({ kind: 'escalation', ts: ev.ts, state })
        break
      }
      case 'escalation_resolved': {
        const idx = this.escalationIndex.get(ev.token)
        if (idx === undefined) {
          // Resolved without a matching request? Append a synthetic resolved card.
          this.append({
            kind: 'escalation',
            ts: ev.ts,
            state: {
              token: ev.token,
              payload: { prompt: '(resolved without matching request)' },
              status: 'resolved',
              decision: ev.decision,
              resolutionMessage: ev.message,
              ts: ev.ts,
            },
          })
          break
        }
        const items = this.state.items.slice()
        const existing = items[idx]
        if (existing && existing.kind === 'escalation') {
          items[idx] = {
            ...existing,
            state: {
              ...existing.state,
              status: 'resolved',
              decision: ev.decision,
              resolutionMessage: ev.message,
            },
          }
          this.state = { ...this.state, items }
          this.emit()
        }
        break
      }
      case 'pi':
        this.handlePiEvent(ev.event, ev.ts)
        break
    }
  }

  private handlePiEvent(event: { type: string; [k: string]: unknown }, ts: number): void {
    switch (event.type) {
      case 'agent_start':
        this.state = { ...this.state, isStreaming: true }
        this.emit()
        break
      case 'message_start': {
        const message = event.message as AgentMessage | undefined
        if (message) this.state = { ...this.state, streamingMessage: message }
        this.emit()
        break
      }
      case 'message_update': {
        const message = event.message as AgentMessage | undefined
        if (message) this.state = { ...this.state, streamingMessage: message }
        this.emit()
        break
      }
      case 'message_end': {
        const message = event.message as AgentMessage | undefined
        if (message) {
          this.append({ kind: 'message', ts, message })
        }
        this.state = { ...this.state, streamingMessage: null }
        this.emit()
        break
      }
      case 'agent_end': {
        // agent_end carries the full messages[] but we've already accumulated
        // them via message_end. Just mark terminal + clear streaming.
        this.state = {
          ...this.state,
          isStreaming: false,
          isTerminal: true,
          terminalKind: 'agent_end',
          streamingMessage: null,
        }
        this.emit()
        break
      }
      case 'agent_error': {
        this.state = {
          ...this.state,
          isStreaming: false,
          isTerminal: true,
          terminalKind: 'agent_error',
          streamingMessage: null,
        }
        this.emit()
        break
      }
      // turn_start / turn_end / tool_execution_* are observable but not
      // required to drive the transcript; MessageList re-renders on
      // message_end will pick up tool calls inside assistant messages.
    }
  }

  private append(item: TranscriptItem): void {
    this.state = { ...this.state, items: [...this.state.items, item] }
    this.emit()
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state)
  }
}
