import { useEffect, useRef } from 'react'
import type { AgentMessage } from '@mariozechner/pi-agent-core'

// Side-effect imports register the custom elements. The aliases keep the
// bundle slim — see vite.config.ts. We only need MessageList + Messages
// (templates registered as a side-effect).
import 'pi-web-ui-internal/components/MessageList.js'
import 'pi-web-ui-internal/components/Messages.js'
import '@mariozechner/mini-lit/dist/MarkdownBlock.js'
// MessageList renders tool calls inside assistant messages; the slim
// tool-index shim registers BashRenderer + DefaultRenderer.
import 'pi-web-ui-internal/tools/index.js'

// Lit-element instance type. We keep it loose because we don't need its
// methods — just to set DOM properties via ref.
interface MessageListElement extends HTMLElement {
  messages: AgentMessage[]
  tools: unknown[]
  isStreaming: boolean
}

// Tell TS the custom element exists in JSX. React 19 moved the JSX
// namespace from the global scope to `React.JSX`, so we extend that.
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'message-list': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>
    }
  }
}

interface Props {
  messages: AgentMessage[]
  isStreaming: boolean
  /** Optional className for layout. */
  className?: string
}

export function MessageListEmbed({
  messages,
  isStreaming,
  className,
}: Props): React.ReactElement {
  const ref = useRef<MessageListElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.messages = messages
    el.tools = []
    el.isStreaming = isStreaming
  }, [messages, isStreaming])

  return (
    <div className={className}>
      {/* The lit element renders into its own shadow root; we just need a
          host element React doesn't try to manage children for. */}
      <message-list ref={ref as unknown as React.Ref<HTMLElement>} />
    </div>
  )
}
