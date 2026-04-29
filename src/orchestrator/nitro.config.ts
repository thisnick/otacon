import { defineConfig } from 'nitro/config'

/**
 * Nitro builds the orchestrator HTTP server. The `workflow/nitro` module
 * registers the SWC plugin that transforms `"use workflow"` and `"use step"`
 * directives at build time.
 *
 * Layout:
 *   server/         — Nitro source dir (routes/, plugins/)
 *   workflows/      — `"use workflow"` bodies, auto-scanned by workflow/nitro
 *
 * Dev: `pnpm dev` → runs `nitro dev` on :9090 (or $PORT).
 * Prod: `pnpm build:server` → compiles to `.output/`; run via
 *       `node .output/server/index.mjs`.
 */
export default defineConfig({
  modules: ['workflow/nitro'],
  serverDir: 'server',
  // Make `workflows/` discoverable to workflow/nitro's scan (in addition to
  // the default which is `workflows/` from each layer's source dir).
  scanDirs: ['workflows'],
  devServer: {
    watch: ['workflows', 'server'],
  },
  experimental: {
    asyncContext: true,
  },
})
