// Entry point. Imports pi-web-ui app.css, registers MessageList /
// StreamingMessageContainer custom elements as a side-effect of importing
// the package, registers tool renderers we want active, and wires the
// hash-router to two page mount functions.

import '@mariozechner/pi-web-ui/app.css'
// Surgical imports through the `pi-web-ui-internal/*` alias defined in
// vite.config.ts. The package's exports map only exposes the barrel, which
// drags in every provider SDK (lmstudio/ollama/anthropic/google/pdfjs/...)
// and blows the bundle past 900KB gz. The alias bypasses the exports map
// at bundle time so we can pull just the components we use.
import 'pi-web-ui-internal/components/MessageList.js'
// MessageList writes `<user-message>` / `<assistant-message>` templates but
// doesn't import the classes that register those custom elements. Without
// this side-effect import the elements stay un-upgraded and render empty.
import 'pi-web-ui-internal/components/Messages.js'
// AssistantMessage's content uses `<markdown-block>` from mini-lit; import
// for the customElement registration side-effect.
import '@mariozechner/mini-lit/dist/MarkdownBlock.js'
// `tools/index.js` is intercepted by a Vite alias and replaced with the
// slim shim at src/shims/tools-index.ts (registers bash + default only).
import 'pi-web-ui-internal/tools/index.js'
import './app.css'

import * as RunsList from './pages/runs-list.js'
import * as SessionDetail from './pages/session-detail.js'
import { onRouteChange, type Route } from './router.js'

// pi-web-ui's CSS uses a `.dark` class on the document root to switch
// `--foreground`/`--background` tokens (Tailwind/shadcn convention). Mirror
// the OS-level prefers-color-scheme onto the class so its components blend
// with our wrapper.
function applyTheme(): void {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', dark)
}
applyTheme()
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)

const root = document.getElementById('app')!
let unmount: (() => void) | null = null

function mountRoute(r: Route): void {
  if (unmount) {
    unmount()
    unmount = null
  }
  // Replace the page mount with a fresh child element so each page has a
  // clean render target. lit-html keeps internal "ChildPart" markers tied
  // to a specific container; wiping the previous container's innerHTML
  // ejects those markers and the next render() throws "ChildPart has no
  // parentNode". A fresh node sidesteps that lifecycle entirely.
  root.replaceChildren()
  const slot = document.createElement('div')
  slot.className = 'page-slot'
  root.appendChild(slot)
  switch (r.name) {
    case 'runs-list':
      unmount = RunsList.mount(slot)
      break
    case 'session-detail':
      unmount = SessionDetail.mount(slot, r.workspace, r.team, r.sid)
      break
    default:
      slot.innerHTML =
        '<p class="not-found">Unknown route. <a href="#/">Go home</a></p>'
  }
}

onRouteChange(mountRoute)
