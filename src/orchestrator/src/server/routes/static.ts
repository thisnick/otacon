/**
 * Static UI bundle handler.
 *
 * Hosts the compiled web app (`web/dist/`) same-origin with the API:
 *   - `/assets/*` — hashed JS/CSS/etc straight off disk
 *   - `/`        — `index.html`
 *   - any other GET that didn't match an API route — SPA fallback to
 *     `index.html` (the React app does client-side routing)
 *
 * Path resolution: anchored at `import.meta.url`. This module lives at
 * `src/server/routes/static.ts`, so going up three levels (`../../..`)
 * lands at the orchestrator package root:
 *   - dev  (tsx src/server/routes/static.ts):       src/orchestrator/web/dist
 *   - prod (compiled dist/src/server/routes/static.js): src/orchestrator/dist/web/dist
 *
 * The Dockerfile is responsible for placing the built bundle at the
 * second path. If the bundle is missing (dev hasn't built), the
 * handlers emit a friendly placeholder HTML rather than crashing the
 * server — `pnpm --filter orchestrator-web build` is the fix.
 *
 * Mounted via `app.route('/', makeStaticRoutes())` AFTER all `/api/*`
 * routes so the API always wins matching.
 */
import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'

const here = dirname(fileURLToPath(import.meta.url))
const distDirAbs = resolve(here, '..', '..', '..', 'web', 'dist')
const indexFileAbs = resolve(distDirAbs, 'index.html')

// `serveStatic` requires paths relative to `process.cwd()`. Compute it
// once; if cwd changes after import, the path stays anchored to where
// the server module lives, which is what we want.
const distDirRel = toRelative(distDirAbs)
const indexFileRel = toRelative(indexFileAbs)

function toRelative(absolute: string): string {
  const rel = relative(process.cwd(), absolute)
  // serveStatic interprets paths relative to cwd; prefix `./` so the
  // intent reads cleanly in logs.
  return rel.startsWith('.') ? rel : `./${rel}`
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>otacon orchestrator</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; color: #222; }
      code { background: #f3f3f3; padding: 0.15rem 0.35rem; border-radius: 3px; }
      h1 { margin-top: 0; }
      .muted { color: #666; font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <h1>Web UI not built</h1>
    <p>The orchestrator server is running, but the web bundle is missing.</p>
    <p>Run:</p>
    <pre><code>pnpm --filter orchestrator-web build</code></pre>
    <p class="muted">The API itself (<code>/api/v1/*</code>, <code>/healthz</code>) is unaffected.</p>
  </body>
</html>
`

export function makeStaticRoutes(): Hono {
  const app = new Hono()

  if (!existsSync(indexFileAbs)) {
    process.stderr.write(
      `[orchestrator-server] web bundle missing at ${indexFileAbs} — serving placeholder. Run: pnpm --filter orchestrator-web build\n`,
    )
  } else {
    process.stderr.write(`[orchestrator-server] serving web UI from ${distDirAbs}\n`)
  }

  // Hashed asset bundle. Falls through to the SPA fallback if the file
  // doesn't exist; for /assets/* that's effectively a 404 since the
  // SPA fallback below only fires on GETs that don't start with /api/
  // or /assets/ — see the rewrite below.
  app.use('/assets/*', serveStatic({ root: distDirRel }))

  // Root + SPA fallback. `path` mode in serveStatic always returns
  // the same single file, regardless of the request URL — perfect for
  // SPA routing. If the file doesn't exist, serveStatic calls next()
  // and the placeholder middleware below handles it.
  //
  // Skip `/api/*` so an unknown API route still gets the JSON 404
  // envelope from `app.notFound`, not the SPA HTML.
  const indexHandler = serveStatic({ path: indexFileRel })
  app.get('/', indexHandler)
  app.get('*', (c, next) => {
    if (c.req.path.startsWith('/api/')) return next()
    return indexHandler(c, next)
  })

  // Final fallback for GETs that fell through (bundle missing).
  app.get('*', (c, next) => {
    if (c.req.path.startsWith('/api/')) return next()
    return c.html(PLACEHOLDER_HTML, 200)
  })

  return app
}
