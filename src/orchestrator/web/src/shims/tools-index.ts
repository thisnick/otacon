// Slim replacement for `@mariozechner/pi-web-ui/dist/tools/index.js`.
//
// The upstream module side-effect-imports javascript-repl + extract-document,
// which drag in SandboxIframe / pdfjs / docx-preview / xlsx / jszip — adding
// ~700 KB gz to the bundle that we never use. This shim re-exports the same
// public surface (renderTool / getToolRenderer / registerToolRenderer /
// setShowJsonMode) and registers BashRenderer + DefaultRenderer, but skips
// the heavy auto-registrations.

import { BashRenderer } from 'pi-web-ui-internal/tools/renderers/BashRenderer.js'
import { DefaultRenderer } from 'pi-web-ui-internal/tools/renderers/DefaultRenderer.js'
import {
  getToolRenderer,
  registerToolRenderer,
} from 'pi-web-ui-internal/tools/renderer-registry.js'

registerToolRenderer('bash', new BashRenderer())
const defaultRenderer = new DefaultRenderer()

let showJsonMode = false

export function setShowJsonMode(enabled: boolean): void {
  showJsonMode = enabled
}

// `result` is typed as `ToolResultMessage<unknown> | undefined` upstream,
// but the call site passes `unknown` (lit-html's typing for child values).
// Cast at the boundary — pi-web-ui's renderer dispatches on shape.
export function renderTool(
  toolName: string,
  params: unknown,
  result: unknown,
  isStreaming?: boolean,
) {
  const r = result as Parameters<DefaultRenderer['render']>[1]
  if (showJsonMode) {
    return defaultRenderer.render(params, r, isStreaming)
  }
  const renderer = getToolRenderer(toolName)
  if (renderer) {
    return renderer.render(params, r, isStreaming)
  }
  return defaultRenderer.render(params, r, isStreaming)
}

export { getToolRenderer, registerToolRenderer }
