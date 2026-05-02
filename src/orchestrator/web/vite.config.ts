import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const API_TARGET = process.env.ORCHESTRATOR_API_URL ?? 'http://localhost:9090'

// pi-web-ui's package.json `exports` only exposes the barrel + app.css.
// Importing the barrel pulls every provider/sandbox/runtime adapter into
// the bundle (~5MB raw / 932KB gzipped). To stay under the 200KB budget we
// alias `pi-web-ui-internal/<file>` to walk directly into dist. This
// bypasses the exports map at bundle time only — runtime behavior is the
// same code, just without the unrelated re-exports.
const PI_WEB_UI_DIST = path.join(
  __dirname,
  'node_modules/@mariozechner/pi-web-ui/dist',
)

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: [
      // `tools/index.js` from upstream pulls in javascript-repl +
      // extract-document, which transitively cost ~700 KB gz (SandboxIframe,
      // pdfjs, docx-preview, xlsx, jszip). Replace it with a slim shim that
      // only registers BashRenderer + DefaultRenderer.
      {
        find: path.join(PI_WEB_UI_DIST, 'tools/index.js'),
        replacement: path.join(__dirname, 'src/shims/tools-index.ts'),
      },
      // Alias for our own deep-imports past the package's exports map.
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
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
})
