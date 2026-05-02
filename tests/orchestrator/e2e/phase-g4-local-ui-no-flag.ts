/**
 * Phase G · G4 — Local CLI `orchestrator ui` (no --api flag).
 *
 * Phase G simplified the `ui` subcommand into a local-only convenience
 * launcher: it always proxies to `http://localhost:9090` and has NO
 * `--api` flag. Verifies:
 *
 *   1. Boot a local API server on :9090 (with a fresh tmp data dir).
 *   2. Spawn `pnpm orchestrator ui --no-open` (no --api).
 *   3. Parse the printed `local: http://localhost:NNNN` URL out of stdout.
 *   4. Playwright opens that URL — RunsList renders, zero non-ignorable
 *      console errors. Page reaches the local UI's same-origin proxy.
 *   5. Every browser-issued `/api/*` request goes to the LOCAL UI URL
 *      (proxy), not bypassing it. The proxy forwards to localhost:9090.
 *
 * This is the kept "convenience launcher for local dev" path after
 * Phase G stripped remote-control from this CLI.
 *
 * Run:
 *   pnpm test:e2e:phase-g:g4
 */
import { chromium, type Browser, type ConsoleMessage, type Page, type Request } from 'playwright'

import {
  ACCOUNT_ID,
  makeTmpDataDir,
  rmTmpDataDir,
  seedLocalDataDir,
  startLocalServer,
  type LocalServerHandle,
} from './helpers/phase-f.js'
import { startLocalUiNoApi, type LocalUiNoApiHandle } from './helpers/phase-g.js'
import {
  assert,
  exitFromCounters,
  info,
  makeCounters,
  section,
  summary,
} from './helpers/spike.js'

const G4_PORT = Number(process.env.OTACON_G4_PORT ?? 9090)

interface RailIO {
  server: LocalServerHandle | null
  ui: LocalUiNoApiHandle | null
  browser: Browser | null
  dataDir: string | null
}
const rail: RailIO = { server: null, ui: null, browser: null, dataDir: null }

async function teardown(): Promise<void> {
  try { if (rail.browser) await rail.browser.close() } catch {}
  try { if (rail.ui) await rail.ui.close() } catch {}
  try { if (rail.server) await rail.server.close() } catch {}
  if (rail.dataDir) rmTmpDataDir(rail.dataDir)
}

function isIgnorableConsoleError(text: string): boolean {
  const t = text.toLowerCase()
  if (t.includes('favicon')) return true
  if (t.includes('react devtools')) return true
  return false
}

async function main(): Promise<void> {
  const c = makeCounters()
  console.log(`\n=== Phase G · G4: Local CLI 'orchestrator ui' (no --api flag) ===`)

  try {
    section('1. Boot local server with seeded tmp data dir on :' + G4_PORT)
    rail.dataDir = makeTmpDataDir('phase-g4')
    info(`tmp data dir: ${rail.dataDir}`)
    const seed = seedLocalDataDir(rail.dataDir)
    assert(c, seed.status === 0, `seed:dev exit 0 (got ${seed.status})`)
    rail.server = await startLocalServer(G4_PORT, rail.dataDir)
    await rail.server.ready
    info(`local API server listening on :${rail.server.port}`)

    // Sanity — local /api/v1/workspaces returns the seeded data.
    const wsCheck = await fetch(`http://127.0.0.1:${G4_PORT}/api/v1/workspaces`)
    assert(c, wsCheck.status === 200, `local /api/v1/workspaces → 200`)
    const wsBody = (await wsCheck.json()) as Array<{ id: string }>
    assert(c, wsBody.some(w => w.id === ACCOUNT_ID), `seeded ${ACCOUNT_ID} present in local server`)

    section('2. Spawn `orchestrator ui --no-open` (no --api flag)')
    rail.ui = await startLocalUiNoApi()
    info(`ui ready at ${rail.ui.url} (printed banner: ${rail.ui.stdoutBuf().split('\n')[0]})`)

    // Sanity — fetching `/` from the ui proxy returns the static index.html.
    const uiRoot = await fetch(rail.ui.url + '/')
    const uiRootBody = await uiRoot.text()
    assert(c, uiRoot.status === 200, `ui GET / → 200 (got ${uiRoot.status})`)
    assert(c, uiRootBody.includes('<div id="app">'), `ui GET / has #app div (real index.html)`)
    assert(c, !uiRootBody.includes('Web UI not built'), `ui GET / is NOT placeholder`)

    // Sanity — the ui proxy forwards /api/* to localhost:9090.
    const proxyWs = await fetch(rail.ui.url + '/api/v1/workspaces')
    assert(c, proxyWs.status === 200, `ui /api/v1/workspaces → 200 via proxy`)
    const proxyBody = (await proxyWs.json()) as Array<{ id: string }>
    assert(
      c,
      proxyBody.some(w => w.id === ACCOUNT_ID),
      `ui proxy returned seeded data (proves localhost:9090 forwarding works)`,
    )

    section('3. Open browser at the local ui URL, observe console + network')
    rail.browser = await chromium.launch({ headless: true })
    const ctx = await rail.browser.newContext()
    const page: Page = await ctx.newPage()

    const consoleErrors: string[] = []
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error' && !isIgnorableConsoleError(msg.text())) {
        consoleErrors.push(`[console.error] ${msg.text()}`)
      }
    })
    page.on('pageerror', err => {
      consoleErrors.push(`[pageerror] ${String((err as Error).message ?? err)}`)
    })

    const apiRequests: { url: string; status: number | null }[] = []
    page.on('request', (req: Request) => {
      const u = req.url()
      if (u.includes('/api/') || u.includes('/traces/')) apiRequests.push({ url: u, status: null })
    })
    page.on('response', res => {
      const url = res.url()
      if (!url.includes('/api/') && !url.includes('/traces/')) return
      const found = apiRequests.find(r => r.url === url && r.status === null)
      if (found) found.status = res.status()
    })

    await page.goto(rail.ui.url, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})

    section('4. RunsList renders + same-origin proxy traffic')
    const title = await page.title()
    info(`title = ${title}`)
    assert(c, title.length > 0, `<title> set (got "${title}")`)

    const appHtml = await page.locator('#app').innerHTML().catch(() => '')
    info(`#app inner length = ${appHtml.length} chars`)
    assert(c, appHtml.length > 50, `#app populated (${appHtml.length} chars)`)

    const lower = appHtml.toLowerCase()
    const hasWorkspaceRef = lower.includes(ACCOUNT_ID.toLowerCase())
    const hasEmptyState =
      lower.includes('no runs') ||
      lower.includes('no sessions') ||
      lower.includes('start a run') ||
      lower.includes('empty')
    info(`RunsList signal — workspaceRef=${hasWorkspaceRef} emptyState=${hasEmptyState}`)
    assert(
      c,
      hasWorkspaceRef || hasEmptyState,
      `RunsList rendered (workspace ref OR empty state)`,
    )

    info(`captured ${apiRequests.length} API/traces requests`)
    for (const r of apiRequests.slice(0, 8)) info(`  ${String(r.status ?? '???')} ${r.url}`)
    assert(c, apiRequests.length > 0, `browser issued ≥1 /api/* request`)

    const offProxy = apiRequests.filter(r => !r.url.startsWith(rail.ui!.url + '/'))
    assert(
      c,
      offProxy.length === 0,
      `every /api/* request went through the local UI proxy (${offProxy.length} bypassed: ${offProxy.slice(0, 2).map(r => r.url).join(', ')})`,
    )

    const failedApi = apiRequests.filter(r => r.status !== null && r.status >= 400)
    assert(
      c,
      failedApi.length === 0,
      `no 4xx/5xx /api/* responses (${failedApi.length} failed: ${failedApi.slice(0, 2).map(r => `${r.status} ${r.url}`).join(' | ')})`,
    )

    info(`console errors captured: ${consoleErrors.length}`)
    for (const e of consoleErrors.slice(0, 8)) info(`  ${e}`)
    assert(
      c,
      consoleErrors.length === 0,
      `zero non-ignorable console errors (${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')})`,
    )
    assert(c, !lower.includes('unknown route'), `not on the unknown route`)
  } finally {
    await teardown()
  }

  summary('Phase G · G4', c)
  exitFromCounters('Phase G · G4', c)
}

main().catch(async err => {
  console.error('G4 threw:', err)
  await teardown()
  process.exit(1)
})
