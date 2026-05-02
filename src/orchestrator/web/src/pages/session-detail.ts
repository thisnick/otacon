// SessionDetail page — header with session metadata, MessageList streaming
// via the `/events` SSE endpoint (replay + tail). Approval / phone-action
// cards inline.

import { html, render, type TemplateResult } from 'lit'
import {
  getSession,
  streamSessionEvents,
  type SseHandle,
} from '../api-client.js'
import { onApprovalCardChange } from '../renderers/approval-card.js'
import { renderTranscript } from '../renderers/transcript.js'
import { TranscriptStore } from '../event-handler.js'
import type { SessionSummary } from '../types.js'

interface State {
  meta: SessionSummary | null
  metaError: string | null
  streamError: string | null
}

export function mount(
  el: HTMLElement,
  workspace: string,
  team: string,
  sid: string,
): () => void {
  const store = new TranscriptStore()
  const local: State = { meta: null, metaError: null, streamError: null }

  const rerender = (): void => {
    render(view(), el)
  }

  const view = (): TemplateResult => {
    const s = store.getState()
    return html`
      <div class="session-detail-page">
        <header class="page-header">
          <a class="back-link" href="#/">← Runs</a>
          <h1>Session <code>${sid}</code></h1>
        </header>
        ${local.metaError
          ? html`<div class="banner banner-error">${local.metaError}</div>`
          : null}
        ${local.meta
          ? html`
              <section class="session-meta-block">
                <dl>
                  <dt>Workspace</dt><dd>${local.meta.workspace}</dd>
                  <dt>Team</dt><dd>${local.meta.team}</dd>
                  <dt>Agent</dt><dd>${local.meta.agentRole}</dd>
                  <dt>Model</dt>
                  <dd>${local.meta.modelProvider}/${local.meta.modelId}</dd>
                  <dt>Status</dt>
                  <dd>
                    <span class="session-status session-status-${local.meta.status}">
                      ${local.meta.status}
                    </span>
                  </dd>
                  <dt>Started</dt>
                  <dd>${new Date(local.meta.startedAt).toLocaleString()}</dd>
                  ${local.meta.endedAt
                    ? html`
                        <dt>Ended</dt>
                        <dd>${new Date(local.meta.endedAt).toLocaleString()}</dd>
                      `
                    : null}
                  ${local.meta.error
                    ? html`<dt>Error</dt><dd><pre>${local.meta.error}</pre></dd>`
                    : null}
                </dl>
              </section>
            `
          : html`<p>Loading session metadata…</p>`}
        ${local.streamError
          ? html`<div class="banner banner-warn">Stream: ${local.streamError}</div>`
          : null}
        <section class="transcript-section">${renderTranscript(s)}</section>
      </div>
    `
  }

  const unsubStore = store.subscribe(rerender)
  const unsubApproval = onApprovalCardChange(rerender)

  // Fetch session metadata.
  void (async () => {
    try {
      local.meta = await getSession(workspace, team, sid)
    } catch (err) {
      local.metaError = err instanceof Error ? err.message : String(err)
    }
    rerender()
  })()

  // Open the SSE replay+tail.
  const sseHandle: SseHandle = streamSessionEvents(workspace, team, sid, {
    onEvent: (ev) => store.ingest(ev),
    onError: (err) => {
      local.streamError = err.message
      rerender()
    },
  })

  return () => {
    sseHandle.close()
    unsubStore()
    unsubApproval()
  }
}
