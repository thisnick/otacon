import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const API_TARGET = process.env.ORCHESTRATOR_API_URL ?? 'http://localhost:9090'
const USE_FIXTURES = process.env.VITE_FIXTURES === '1'

// pi-web-ui's package.json `exports` only exposes the barrel + app.css.
// Importing the barrel pulls every provider/sandbox/runtime adapter into
// the bundle. To trim it we (a) alias `pi-web-ui-internal/<file>` past the
// exports map for surgical imports of MessageList only, and (b) replace
// `tools/index.js` with a slim shim that drops javascript-repl +
// extract-document and their pdfjs/docx/xlsx deps. The MessageList web
// component is embedded as a custom HTML element inside the React
// RunDetail page; nothing else from pi-web-ui ships in the bundle.
const PI_WEB_UI_DIST = path.join(
  __dirname,
  'node_modules/@mariozechner/pi-web-ui/dist',
)
const FIXTURES_DIR = path.join(__dirname, 'fixtures')

// Hand-rolled mock for the read-side endpoints we exercise during dev
// when server-implementer's PR isn't on this checkout. Mocked endpoints
// match the JSON shapes in plan §5. Writes return 501 so devs notice and
// switch to the real server (drop `VITE_FIXTURES=1`).
function fixturesPlugin(): Plugin {
  function jsonResponse(res: import('node:http').ServerResponse, status: number, body: unknown): void {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }
  function textResponse(res: import('node:http').ServerResponse, status: number, body: string, ctype = 'text/markdown'): void {
    res.statusCode = status
    res.setHeader('Content-Type', ctype)
    res.end(body)
  }
  function readFixture(file: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8'))
  }
  return {
    name: 'orchestrator-fixtures',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/api/v1/')) return next()
        if (req.method && req.method !== 'GET') {
          return jsonResponse(res, 501, {
            error: {
              code: 'fixture_not_implemented',
              message: `${req.method} ${url} not in fixture mode; run real server`,
            },
          })
        }
        const trail = decodeURIComponent(url.slice('/api/v1/'.length).split('?')[0])
        const segs = trail.split('/').filter(Boolean)

        if (segs.length === 1 && segs[0] === 'workspaces') {
          return jsonResponse(res, 200, readFixture('workspaces.json'))
        }
        if (segs.length === 1 && segs[0] === 'teams') {
          return jsonResponse(res, 200, readFixture('teams.json'))
        }
        if (segs.length === 1 && segs[0] === 'phones') {
          return jsonResponse(res, 200, readFixture('phones.json'))
        }
        if (segs.length === 2 && segs[0] === 'workspaces') {
          const list = readFixture('workspaces.json') as Array<{ id: string }>
          const found = list.find((w) => w.id === segs[1])
          if (!found) return jsonResponse(res, 404, { error: { code: 'workspace_not_found', message: 'fixture' } })
          return jsonResponse(res, 200, found)
        }
        if (segs.length === 3 && segs[0] === 'workspaces' && segs[2] === 'env') {
          return jsonResponse(res, 200, [
            { name: 'persona.md', size: 256, modifiedAt: Date.now() - 3600_000 },
            { name: 'soul.md', size: 128, modifiedAt: Date.now() - 7200_000 },
            { name: 'memory.md', size: 64, modifiedAt: Date.now() - 600_000 },
          ])
        }
        if (segs.length === 4 && segs[0] === 'workspaces' && segs[2] === 'env') {
          return textResponse(res, 200, `# ${segs[3]}\n\n(fixture content)\n`)
        }
        if (segs.length === 3 && segs[0] === 'workspaces' && segs[2] === 'credentials') {
          return jsonResponse(res, 200, { hasCredentials: false, fieldsSet: [] })
        }
        if (segs.length === 2 && segs[0] === 'teams') {
          const list = readFixture('teams.json') as Array<{ name: string }>
          const found = list.find((t) => t.name === segs[1])
          if (!found) return jsonResponse(res, 404, { error: { code: 'team_not_found', message: 'fixture' } })
          return jsonResponse(res, 200, found)
        }
        if (segs.length === 4 && segs[0] === 'teams' && segs[2] === 'prompts') {
          return textResponse(res, 200, `# ${segs[3]}\n\n(fixture prompt)\n`)
        }
        if (
          segs.length === 5 &&
          segs[0] === 'workspaces' &&
          segs[2] === 'teams' &&
          segs[4] === 'sessions'
        ) {
          return jsonResponse(res, 200, readFixture('sessions.json'))
        }
        if (
          segs.length === 3 &&
          segs[0] === 'workspaces' &&
          segs[2] === 'sessions'
        ) {
          // Cross-team workspace sessions (Phase I server commit 813ce42).
          return jsonResponse(res, 200, readFixture('sessions.json'))
        }
        if (
          segs.length === 4 &&
          segs[0] === 'workspaces' &&
          segs[2] === 'teams'
        ) {
          // GET /workspaces/:ws/teams — per-workspace teams list (Phase B route).
          return jsonResponse(res, 200, readFixture('teams.json'))
        }

        return jsonResponse(res, 404, {
          error: {
            code: 'fixture_not_found',
            message: `no fixture for /api/v1/${trail}`,
          },
        })
      })
    },
  }
}

export default defineConfig({
  root: __dirname,
  plugins: [
    react(),
    tailwindcss(),
    ...(USE_FIXTURES ? [fixturesPlugin()] : []),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: path.join(__dirname, 'src') },
      // Order matters: this string alias must precede the regex below so it
      // catches the import path before it gets rewritten to an absolute
      // node_modules location. Replaces upstream's tools/index.js (which
      // imports pdfjs/docx/xlsx/sandbox-iframe + every provider SDK) with
      // a slim shim — see src/shims/tools-index.ts. Without this the bundle
      // balloons from ~180 KB gz to 500+ KB gz.
      {
        find: 'pi-web-ui-internal/tools/index.js',
        replacement: path.join(__dirname, 'src/shims/tools-index.ts'),
      },
      // Also handle the absolute-path form for any code paths that already
      // resolved through node's resolution.
      {
        find: path.join(PI_WEB_UI_DIST, 'tools/index.js'),
        replacement: path.join(__dirname, 'src/shims/tools-index.ts'),
      },
      {
        find: /^pi-web-ui-internal\/(.*)$/,
        replacement: `${PI_WEB_UI_DIST}/$1`,
      },
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: USE_FIXTURES
      ? undefined
      : {
          '/api': {
            target: API_TARGET,
            changeOrigin: true,
          },
        },
  },
})
