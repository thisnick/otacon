// Renders the chronological transcript: chat messages from MessageList +
// inline cards (phone_action, escalation, system, user_text).
//
// Strategy: group consecutive `message` items into chunks rendered by a
// shared MessageList instance, and render `card` items inline between
// chunks. Custom elements are registered as a side-effect of importing
// pi-web-ui's MessageList / StreamingMessageContainer modules.

import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { html, nothing, type TemplateResult } from 'lit'
import type { TranscriptItem, TranscriptState } from '../event-handler.js'
import { renderApprovalCard } from './approval-card.js'
import { renderPhoneAction } from './phone-action.js'

interface MessageChunk {
  kind: 'msg-chunk'
  messages: AgentMessage[]
  isStreaming: boolean
  streamingMessage: AgentMessage | null
}

interface CardChunk {
  kind: 'card'
  item: TranscriptItem
}

type Chunk = MessageChunk | CardChunk

export function chunkItems(state: TranscriptState): Chunk[] {
  const chunks: Chunk[] = []
  let current: MessageChunk | null = null
  for (const item of state.items) {
    if (item.kind === 'message') {
      if (!current) {
        current = {
          kind: 'msg-chunk',
          messages: [],
          isStreaming: false,
          streamingMessage: null,
        }
        chunks.push(current)
      }
      current.messages.push(item.message)
    } else {
      current = null
      chunks.push({ kind: 'card', item })
    }
  }
  if (state.streamingMessage) {
    if (current) {
      current.isStreaming = state.isStreaming
      current.streamingMessage = state.streamingMessage
    } else {
      chunks.push({
        kind: 'msg-chunk',
        messages: [],
        isStreaming: state.isStreaming,
        streamingMessage: state.streamingMessage,
      })
    }
  }
  return chunks
}

function renderCard(item: TranscriptItem): TemplateResult | typeof nothing {
  switch (item.kind) {
    case 'phone_action':
      return renderPhoneAction(item.payload)
    case 'escalation':
      return renderApprovalCard(item.state)
    case 'system':
      return html`
        <details class="transcript-system">
          <summary>system prompt set</summary>
          <pre>${item.prompt}</pre>
        </details>
      `
    case 'user_text':
      return html`
        <div class="transcript-user-msg">
          <span class="transcript-user-badge">user</span>
          <pre>${item.text}</pre>
        </div>
      `
    default:
      return nothing
  }
}

function renderMessageChunk(chunk: MessageChunk): TemplateResult {
  // If a streaming message is in flight, append it to the messages array and
  // flip isStreaming. MessageList re-renders fine each animation frame; we
  // avoid wiring up StreamingMessageContainer's imperative setMessage() API.
  const messages = chunk.streamingMessage
    ? [...chunk.messages, chunk.streamingMessage]
    : chunk.messages
  if (messages.length === 0) return html`${nothing}`
  return html`
    <div class="transcript-chunk">
      <message-list
        .messages=${messages}
        .tools=${[]}
        .isStreaming=${chunk.isStreaming}
      ></message-list>
    </div>
  `
}

export function renderTranscript(state: TranscriptState): TemplateResult {
  if (state.items.length === 0 && !state.streamingMessage) {
    return html`<p class="transcript-empty">Waiting for events…</p>`
  }
  const chunks = chunkItems(state)
  return html`
    <div class="transcript">
      ${chunks.map((c) =>
        c.kind === 'msg-chunk' ? renderMessageChunk(c) : renderCard(c.item),
      )}
      ${state.isTerminal
        ? html`
            <p class="transcript-terminal">
              ${state.terminalKind === 'agent_error'
                ? 'Run ended with error.'
                : 'Run completed.'}
            </p>
          `
        : nothing}
    </div>
  `
}
