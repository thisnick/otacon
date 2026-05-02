/**
 * Orchestrator HTTP API server.
 *
 * Composes the route modules under a single Hono app at `/api/v1/`. Routes
 * are split by file under `routes/`:
 *   - workspaces.ts   — workspace + team list
 *   - sessions.ts     — session metadata + event/message replay + traces
 *   - runs.ts         — POST /runs (start/resume + SSE)
 *   - escalations.ts  — POST /escalations/:token/resolve
 *
 * Auth: none (Tailscale ingress is the fence per spec).
 *
 * The server is otherwise stateless — each request reads the on-disk file
 * tree fresh, and live runs are anchored on a fresh Agent + bus per POST.
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { dataRoot as defaultDataRoot } from '../storage/paths.js'
import { abortStaleRunningSessions } from './startup.js'
import { makeWorkspacesRoutes } from './routes/workspaces.js'
import { makeSessionsRoutes } from './routes/sessions.js'
import { makeRunsRoutes } from './routes/runs.js'
import { makeEscalationsRoutes } from './routes/escalations.js'

export interface ServerOpts {
  port?: number
  host?: string
  dataRoot?: string
}

export interface RunningServer {
  port: number
  host: string
  close: () => Promise<void>
}

export function buildApp(opts: { dataRoot: string }): Hono {
  const app = new Hono()

  app.get('/healthz', (c) => c.json({ ok: true }))

  const v1 = new Hono()
  v1.route('/', makeWorkspacesRoutes({ dataRoot: opts.dataRoot }))
  v1.route('/', makeSessionsRoutes({ dataRoot: opts.dataRoot }))
  v1.route('/', makeRunsRoutes({ dataRoot: opts.dataRoot }))
  v1.route('/', makeEscalationsRoutes({ dataRoot: opts.dataRoot }))

  app.route('/api/v1', v1)

  // Standard 404 for unknown routes — matches spec's error envelope.
  app.notFound((c) =>
    c.json({ error: { code: 'bad_request', message: `route not found: ${c.req.method} ${c.req.path}` } }, 404),
  )

  app.onError((err, c) => {
    console.error('[orchestrator-server] unhandled error:', err)
    return c.json({ error: { code: 'internal', message: err instanceof Error ? err.message : String(err) } }, 500)
  })

  return app
}

export async function startServer(opts: ServerOpts = {}): Promise<RunningServer> {
  const port = opts.port ?? Number(process.env.PORT ?? 9090)
  const host = opts.host ?? '0.0.0.0'
  const dataRoot = opts.dataRoot ?? defaultDataRoot()

  const aborted = await abortStaleRunningSessions(dataRoot)
  if (aborted > 0) {
    process.stderr.write(`[orchestrator-server] aborted ${aborted} stale "running" session(s) on startup\n`)
  }

  const app = buildApp({ dataRoot })
  const server = serve({ fetch: app.fetch, port, hostname: host })

  process.stderr.write(`[orchestrator-server] listening on http://${host}:${port} (data: ${dataRoot})\n`)

  return {
    port,
    host,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
