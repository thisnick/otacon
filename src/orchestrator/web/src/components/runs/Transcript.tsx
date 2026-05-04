import { useMemo } from 'react'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { TranscriptItem, TranscriptState } from '@/lib/event-handler'
import { MessageListEmbed } from '@/components/runs/MessageListEmbed'
import { PhoneActionCard } from '@/components/runs/PhoneActionCard'
import { EscalationCard } from '@/components/runs/EscalationCard'

interface Props {
  state: TranscriptState
}

interface MessageChunk {
  kind: 'msg-chunk'
  messages: AgentMessage[]
  isStreaming: boolean
}

interface CardChunk {
  kind: 'card'
  item: TranscriptItem
}

type Chunk = MessageChunk | CardChunk

function chunkItems(state: TranscriptState): Chunk[] {
  const chunks: Chunk[] = []
  let current: MessageChunk | null = null
  for (const item of state.items) {
    if (item.kind === 'message') {
      if (!current) {
        current = { kind: 'msg-chunk', messages: [], isStreaming: false }
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
      current.messages.push(state.streamingMessage)
    } else {
      chunks.push({
        kind: 'msg-chunk',
        messages: [state.streamingMessage],
        isStreaming: state.isStreaming,
      })
    }
  }
  return chunks
}

export function Transcript({ state }: Props): React.ReactElement {
  const chunks = useMemo(() => chunkItems(state), [state])
  return (
    <div className="flex flex-col gap-2" data-testid="transcript">
      {chunks.length === 0 && (
        <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
          Waiting for the first message...
        </div>
      )}
      {chunks.map((chunk, i) => {
        if (chunk.kind === 'msg-chunk') {
          return (
            <MessageListEmbed
              key={`msgs-${i}`}
              messages={chunk.messages}
              isStreaming={chunk.isStreaming}
            />
          )
        }
        const item = chunk.item
        switch (item.kind) {
          case 'phone_action':
            return <PhoneActionCard key={`pa-${i}`} payload={item.payload} />
          case 'escalation':
            return <EscalationCard key={`esc-${item.state.token}-${i}`} state={item.state} />
          case 'system':
            return (
              <details
                key={`sys-${i}`}
                className="my-2 rounded-md border bg-muted/50 px-3 py-2 text-xs"
              >
                <summary className="cursor-pointer font-medium">system prompt</summary>
                <pre className="mt-2 whitespace-pre-wrap font-mono">{item.prompt}</pre>
              </details>
            )
          case 'user_text':
            return (
              <div
                key={`ut-${i}`}
                className="self-end max-w-[80%] rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
              >
                {item.text}
              </div>
            )
          default:
            return null
        }
      })}
    </div>
  )
}
