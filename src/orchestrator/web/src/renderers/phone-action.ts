// Renders a `phone_action` OtaconEvent as an inline card with three
// thumbnails (before / annotated / after). Click a thumbnail to enlarge.

import { html, type TemplateResult } from 'lit'
import { traceUrl } from '../api-client.js'
import type { PhoneActionPayload } from '../types.js'
import { openImageModal } from './image-modal.js'

function summary(payload: PhoneActionPayload): string {
  const parts = [payload.command]
  if (payload.subcommand) parts.push(payload.subcommand)
  if (payload.target) parts.push(payload.target)
  return parts.filter(Boolean).join(' ')
}

function thumbnail(label: string, url: string | null): TemplateResult {
  if (!url) {
    return html`
      <div class="phone-action-thumb phone-action-thumb-empty">
        <span class="phone-action-thumb-label">${label}</span>
        <span class="phone-action-thumb-missing">—</span>
      </div>
    `
  }
  return html`
    <button
      class="phone-action-thumb"
      type="button"
      @click=${() => openImageModal(url, label)}
    >
      <span class="phone-action-thumb-label">${label}</span>
      <img src=${url} alt=${label} loading="lazy" />
    </button>
  `
}

export function renderPhoneAction(payload: PhoneActionPayload): TemplateResult {
  const before = traceUrl(payload.screenshots.before)
  const annotated = traceUrl(payload.screenshots.annotated)
  const after = traceUrl(payload.screenshots.after)
  const ok = payload.exitCode === 0
  return html`
    <section class="phone-action-card ${ok ? 'phone-action-ok' : 'phone-action-err'}">
      <header class="phone-action-header">
        <code class="phone-action-cmd">${summary(payload)}</code>
        <span class="phone-action-status">
          ${ok ? 'ok' : `exit ${payload.exitCode}`}
        </span>
      </header>
      ${payload.rationale
        ? html`<p class="phone-action-rationale">${payload.rationale}</p>`
        : null}
      <div class="phone-action-thumbs">
        ${thumbnail('before', before)}
        ${thumbnail('annotated', annotated)}
        ${thumbnail('after', after)}
      </div>
      ${payload.stderr
        ? html`<pre class="phone-action-stderr">${payload.stderr}</pre>`
        : null}
    </section>
  `
}
