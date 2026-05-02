// Renders an `escalation_requested` OtaconEvent as an interactive card.
// Buttons POST to /api/v1/escalations/:token/resolve. Card transitions to
// `resolved` style once the matching `escalation_resolved` event lands (the
// store rewrites the item in place; we just re-render).

import { html, type TemplateResult } from 'lit'
import { resolveEscalation, ApiClientError } from '../api-client.js'
import type { EscalationCardState } from '../event-handler.js'

const submitting = new Set<string>()
const errors = new Map<string, string>()
const callbacks = new Set<() => void>()

function notify(): void {
  for (const cb of callbacks) cb()
}

export function onApprovalCardChange(cb: () => void): () => void {
  callbacks.add(cb)
  return () => callbacks.delete(cb)
}

async function submit(token: string, decision: 'approve' | 'reject'): Promise<void> {
  if (submitting.has(token)) return
  submitting.add(token)
  errors.delete(token)
  notify()
  try {
    await resolveEscalation(token, { decision })
    // No-op on success — the matching `escalation_resolved` event will arrive
    // via the SSE stream and flip the card.
  } catch (err) {
    if (err instanceof ApiClientError && err.code === 'escalation_already_resolved') {
      // Race: someone resolved it; the resolved event will arrive shortly.
    } else {
      errors.set(token, err instanceof Error ? err.message : String(err))
    }
  } finally {
    submitting.delete(token)
    notify()
  }
}

export function renderApprovalCard(state: EscalationCardState): TemplateResult {
  if (state.status === 'resolved') {
    const cls = state.decision === 'approve' ? 'approved' : 'rejected'
    return html`
      <section class="approval-card approval-${cls}">
        <header class="approval-header">
          <span class="approval-badge">${state.decision === 'approve' ? 'approved' : 'rejected'}</span>
        </header>
        <pre class="approval-prompt">${state.payload.prompt}</pre>
        ${state.resolutionMessage
          ? html`<p class="approval-note">${state.resolutionMessage}</p>`
          : null}
      </section>
    `
  }
  const isSubmitting = submitting.has(state.token)
  const err = errors.get(state.token)
  return html`
    <section class="approval-card approval-pending">
      <header class="approval-header">
        <span class="approval-badge">approval requested</span>
      </header>
      <pre class="approval-prompt">${state.payload.prompt}</pre>
      <div class="approval-actions">
        <button
          type="button"
          class="approval-btn approval-btn-approve"
          ?disabled=${isSubmitting}
          @click=${() => void submit(state.token, 'approve')}
        >
          ${isSubmitting ? 'submitting…' : 'Approve'}
        </button>
        <button
          type="button"
          class="approval-btn approval-btn-reject"
          ?disabled=${isSubmitting}
          @click=${() => void submit(state.token, 'reject')}
        >
          Reject
        </button>
      </div>
      ${err ? html`<p class="approval-error">${err}</p>` : null}
    </section>
  `
}
