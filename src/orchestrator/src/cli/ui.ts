/**
 * `orchestrator ui` — local-dev convenience launcher for the web UI.
 *
 * Spawns a tiny static HTTP server that serves the bundled web UI from
 * `web/dist/` and proxies `/api/*` to a local API server. Used during
 * local iteration so the UI bundle resolves same-origin against the
 * `orchestrator serve` running on `localhost:9090`.
 *
 * For the deployed orchestrator, the API server hosts the UI itself at
 * `/` — open the deployed URL directly in a browser. There is no
 * remote-mode flag here; this subcommand exists for local dev only.
 */
import type { Command } from 'commander'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { spawn } from 'node:child_process'

const LOCAL_API = 'http://localhost:9090'
const PORT_RANGE_START = 5174
const PORT_RANGE_END = 5184

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export interface UiCommandOpts {
  port?: string
  open?: boolean
}

export function registerUi(program: Command): void {
  program
    .command('ui')
    .description(
      'Open the web UI for a LOCAL orchestrator (http://localhost:9090). ' +
        'For the deployed orchestrator, just open its URL in a browser — ' +
        'the server hosts the UI same-origin at /.',
    )
    .option('-p, --port <number>', `Local port (default auto-pick in ${PORT_RANGE_START}-${PORT_RANGE_END}).`)
    .option('--no-open', "Don't auto-open the browser.")
    .action(async (optsRaw: UiCommandOpts) => {
      const distDir = resolveDistDir()
      if (!existsSync(distDir) || !existsSync(join(distDir, 'index.html'))) {
        process.stderr.write(
          `web UI not built. Run: pnpm --filter orchestrator-web build\n  (looked in: ${distDir})\n`,
        )
        process.exit(1)
      }

      const requestedPort = optsRaw.port !== undefined ? Number(optsRaw.port) : undefined
      const port = await pickPort(requestedPort)

      const server = createHttpServer((req, res) => {
        handleRequest(req, res, { distDir, apiBase: LOCAL_API }).catch(err => {
          process.stderr.write(`[orchestrator-ui] handler error: ${String((err as Error)?.message ?? err)}\n`)
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          }
          if (!res.writableEnded) res.end('internal error')
        })
      })

      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', rejectListen)
          resolveListen()
        })
      })

      const localUrl = `http://localhost:${port}`
      const lines = [
        'orchestrator ui (local dev)',
        `  api:    ${LOCAL_API}`,
        `  local:  ${localUrl}`,
      ]
      if (optsRaw.open !== false) lines.push('  opening browser...')
      process.stdout.write(lines.join('\n') + '\n')

      if (optsRaw.open !== false) openBrowser(localUrl)

      const shutdown = () => {
        process.stderr.write(`\n[orchestrator-ui] shutting down\n`)
        server.close(() => process.exit(0))
        // hard exit after short grace period in case of stuck connections
        setTimeout(() => process.exit(0), 500).unref()
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)

      await new Promise<void>(() => {})
    })
}

function resolveDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // Layout: src/cli/ui.ts → ../../web/dist
  return resolve(here, '..', '..', 'web', 'dist')
}

async function pickPort(requested: number | undefined): Promise<number> {
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested < 1 || requested > 65535) {
      throw new Error(`invalid --port: ${requested}`)
    }
    return requested
  }
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (await portFree(p)) return p
  }
  throw new Error(`no free port in ${PORT_RANGE_START}-${PORT_RANGE_END}; pass --port`)
}

function portFree(port: number): Promise<boolean> {
  return new Promise(resolveBool => {
    const probe = createHttpServer()
    probe.once('error', () => resolveBool(false))
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolveBool(true))
    })
  })
}

interface HandlerCtx {
  distDir: string
  apiBase: string
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)

  if (pathname.startsWith('/api/') || pathname === '/api') {
    return proxyApi(req, res, ctx.apiBase, url)
  }

  // Static + SPA fallback (GET/HEAD only).
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
    res.end('method not allowed')
    return
  }

  await serveStatic(req, res, ctx)
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'

  // Prevent path traversal: resolve and ensure result stays inside distDir.
  const requested = normalize(join(ctx.distDir, pathname))
  const distRoot = ctx.distDir.endsWith(sep) ? ctx.distDir : ctx.distDir + sep
  const inside = requested === ctx.distDir || requested.startsWith(distRoot)

  if (inside && existsSync(requested) && statSync(requested).isFile()) {
    if (requested.endsWith(`${sep}index.html`) || requested === join(ctx.distDir, 'index.html')) {
      await sendIndexHtml(res, ctx)
      return
    }
    sendFile(res, requested)
    return
  }

  // SPA fallback: any non-/api/ GET that doesn't resolve to a file → index.html.
  await sendIndexHtml(res, ctx)
}

async function sendIndexHtml(res: ServerResponse, ctx: HandlerCtx): Promise<void> {
  const indexPath = join(ctx.distDir, 'index.html')
  const html = await readFile(indexPath, 'utf8')
  // Inject empty string so the web app uses same-origin and routes through
  // this CLI's `/api/*` proxy (which forwards to ctx.apiBase). Injecting the
  // upstream URL directly would defeat the proxy.
  const inject = `<script>window.__API_BASE__ = '';</script>`
  const injected = html.includes('</head>')
    ? html.replace('</head>', `    ${inject}\n  </head>`)
    : inject + html
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(injected)
}

function sendFile(res: ServerResponse, filePath: string): void {
  const ext = extname(filePath).toLowerCase()
  const type = MIME[ext] ?? 'application/octet-stream'
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-cache',
  })
  createReadStream(filePath).pipe(res)
}

function proxyApi(req: IncomingMessage, res: ServerResponse, apiBase: string, incoming: URL): void {
  const target = new URL(apiBase + incoming.pathname + incoming.search)
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    const lk = k.toLowerCase()
    if (lk === 'host' || lk === 'connection' || lk === 'content-length') continue
    headers[k] = v as string | string[]
  }
  headers['host'] = target.host
  // Preserve SSE — disable any transparent buffering.
  if ((req.headers['accept'] ?? '').includes('text/event-stream')) {
    headers['accept'] = 'text/event-stream'
  }

  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: target.pathname + target.search,
      headers,
    },
    upstreamRes => {
      const status = upstreamRes.statusCode ?? 502
      const outHeaders: Record<string, string | string[]> = {}
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v === undefined) continue
        outHeaders[k] = v
      }
      res.writeHead(status, outHeaders)
      upstreamRes.pipe(res)
    },
  )

  upstream.on('error', err => {
    process.stderr.write(`[orchestrator-ui] proxy error → ${target.href}: ${String((err as Error)?.message ?? err)}\n`)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { code: 'proxy_error', message: String((err as Error)?.message ?? err) } }))
    } else if (!res.writableEnded) {
      res.end()
    }
  })

  req.on('aborted', () => {
    upstream.destroy()
  })

  req.pipe(upstream)
}

function openBrowser(url: string): void {
  const platform = process.platform
  let cmd: string
  let args: string[]
  if (platform === 'darwin') {
    cmd = 'open'
    args = [url]
  } else if (platform === 'win32') {
    cmd = 'cmd'
    args = ['/c', 'start', '""', url]
  } else {
    cmd = 'xdg-open'
    args = [url]
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {
      // swallow — printing the URL is enough.
    })
    child.unref()
  } catch {
    // ignored — printing the URL is enough.
  }
}
