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
// `tools/index.js` is intercepted by a Vite alias and replaced with the
// slim shim at src/shims/tools-index.ts (registers bash + default only).
import 'pi-web-ui-internal/tools/index.js'
import './app.css'

import * as RunsList from './pages/runs-list.js'
import * as SessionDetail from './pages/session-detail.js'
import { onRouteChange, type Route } from './router.js'

const root = document.getElementById('app')!
let unmount: (() => void) | null = null

function mountRoute(r: Route): void {
  if (unmount) {
    unmount()
    unmount = null
  }
  root.innerHTML = ''
  switch (r.name) {
    case 'runs-list':
      unmount = RunsList.mount(root)
      break
    case 'session-detail':
      unmount = SessionDetail.mount(root, r.workspace, r.team, r.sid)
      break
    default:
      root.innerHTML =
        '<p class="not-found">Unknown route. <a href="#/">Go home</a></p>'
  }
}

onRouteChange(mountRoute)
