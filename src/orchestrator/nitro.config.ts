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
  // workflow/nitro emits step registrations as top-level side effects in
  // `node_modules/.nitro/workflow/steps.mjs`. The plugin adds a bare
  // side-effect import (`import "...steps.mjs";`) to the virtual route
  // handler — but in production builds Rollup's tree-shaker drops it
  // because node_modules defaults to `moduleSideEffects: false`. Without
  // these registrations, runs fail with `StepNotRegisteredError`. Patch
  // the rollup treeshake config to mark the generated workflow bundles as
  // side-effectful so the bare imports survive tree-shaking.
  hooks: {
    'rollup:before': (_nitro, config) => {
      const treeshake = (config.treeshake ?? {}) as Record<string, unknown>
      const inner = treeshake.moduleSideEffects as
        | ((id: string, external: boolean) => boolean)
        | undefined
      config.treeshake = {
        ...treeshake,
        moduleSideEffects(id: string, external: boolean) {
          if (id.includes('.nitro/workflow/')) return true
          return inner ? inner(id, external) : false
        },
      } as typeof config.treeshake
    },
  },
  // Make `workflows/` discoverable to workflow/nitro's scan (in addition to
  // the default which is `workflows/` from each layer's source dir).
  scanDirs: ['workflows'],
  // Serve the vanilla HTML/JS/CSS web UI (P4-I) at `/`. `index.html` is the
  // runs list, `run.html` is the per-run timeline. No bundler; pure static
  // serve. Nitro picks up `index.html` automatically when `/` is requested.
  publicAssets: [
    {
      baseURL: '/',
      dir: 'static',
      maxAge: 0,
    },
  ],
  devServer: {
    watch: ['workflows', 'server', 'static'],
  },
  experimental: {
    asyncContext: true,
    // Note: tried `openAPI: true` to enable Nitro's auto-generated spec
    // at `/_openapi.json` + `/_swagger`, but Nitro 3.0.1-alpha's route-
    // meta extractor crashes on `workflow/nitro`'s virtual handlers
    // (`\x00virtual:#workflow/webhook.mjs` — null-byte in path).
    // Independently, every route file with a `defineRouteMeta(...)` call
    // hit a TDZ `Cannot access '<name>$1' before initialization`. Both
    // are nitro-3-alpha bugs we live with for now; revisit when nitro
    // releases a stable 3.x or moves to nitro 4.
  },
})
