/**
 * Phase F · F4 — Remote UI mode (orchestrator ui --api <deployed VPS>).
 *
 * Verifies the canonical "operate the deployed VPS from a developer laptop"
 * flow:
 *   1. `orchestrator ui --api https://otacon-orchestrator.tail0437b8.ts.net
 *      --no-open` locally — picks a port, proxies /api/* to the deployed VPS.
 *   2. Open the local URL in a Playwright headless browser.
 *   3. Verify the React app boots, fetches workspaces from the VPS through
 *      the local CLI proxy, renders RunsList without console errors.
 *   4. Verify network calls indeed hit `localhost:<cli-proxy-port>` (and
 *      transitively the VPS upstream returns 200 for /api/v1/workspaces).
 *
 * NOT exercising the New Run flow here — that's F1 (POST /runs against the
 * VPS) and F8 (canonical XHS run). F4 is the "the proxy works + UI loads
 * remote data" assertion.
 *
 * If the deployed VPS has any sessions (from F1 or earlier), they should
 * appear in the rendered RunsList. F4 assertion is "RunsList has at least
 * one row OR shows the empty-state UI" — both prove the UI talked to the
 * remote API successfully.
 *
 * Run:
 *   pnpm test:e2e:phase-f:f4
 */
import { chromium, type Browser, type ConsoleMessage, type Page, type Request } from 'playwright'

import {
  ACCOUNT_ID,
  ACCOUNT_ID_ENC,
  VPS_API_BASE,
  startLocalUi,
} from './helpers/phase-f.js'
import {
  assert,
  exitFromCounters,
  info,
  makeCounters,
  section,
  summary,
} from './helpers/spike.js'

interface RailIO {
  uiHandle: { close: () => Promise<void> } | null
  browser: Browser | null
}

const rail: RailIO = { uiHandle: null, browser: null }

async function teardown(): Promise<void> {
  try { if (rail.browser) await rail.browser.close() } catch {}
  try { if (rail.uiHandle) await rail.uiHandle.close() } catch {}
}

async function main(): Promise<void> {
  const c = makeCounters()
  console.log(`\n=== Phase F · F4: Remote UI mode ===`)
  console.log(`vps API = ${VPS_API_BASE}`)

  try {
    section('1. Start `orchestrator ui --api <VPS>` locally')
    rail.uiHandle = await startLocalUi(VPS_API_BASE)
    info(`ui ready at ${rail.uiHandle.url}`)

    section('2. Sanity — proxy forwards to VPS')
    const proxyWs = await fetch(`${rail.uiHandle.url}/api/v1/workspaces`)
    assert(c, proxyWs.status === 200, `proxy GET /api/v1/workspaces → 200 (got ${proxyWs.status})`)
    const wsJson = (await proxyWs.json()) as Array<{ id: string }>
    assert(c, Array.isArray(wsJson) && wsJson.length > 0, `proxy returned non-empty workspaces array`)
    assert(c, wsJson.some(w => w.id === ACCOUNT_ID), `proxy returned seeded ${ACCOUNT_ID} (proves VPS round-trip)`)

    // Also exercise a deeper route to verify proxy doesn't choke on URL-encoded
    // workspace ids (xhs:test → xhs%3Atest).
    const proxyTeams = await fetch(`${rail.uiHandle.url}/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams`)
    assert(c, proxyTeams.status === 200, `proxy GET .../teams → 200 (got ${proxyTeams.status})`)

    section('3. Open browser, verify React app boots and consumes proxy')
    rail.browser = await chromium.launch({ headless: true })
    const ctx = await rail.browser.newContext()
    const page: Page = await ctx.newPage()

    const consoleErrors: string[] = []
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(`[console.error] ${msg.text()}`)
    })
    page.on('pageerror', err => {
      consoleErrors.push(`[pageerror] ${String((err as Error).message ?? err)}`)
    })

    // Capture network requests for assertion: every /api/* call should hit
    // the local CLI proxy (NOT the VPS directly from the browser).
    const apiRequests: { url: string; status: number | null }[] = []
    page.on('request', (req: Request) => {
      if (req.url().includes('/api/')) apiRequests.push({ url: req.url(), status: null })
    })
    page.on('response', res => {
      const url = res.url()
      if (!url.includes('/api/')) return
      const found = apiRequests.find(r => r.url === url && r.status === null)
      if (found) found.status = res.status()
    })

    await page.goto(rail.uiHandle.url, { waitUntil: 'domcontentloaded' })
    // Give the React app a moment to fetch + render.
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})

    const appHtml = await page.locator('#app').innerHTML().catch(() => '')
    assert(c, appHtml.length > 50, `#app populated after React boot (${appHtml.length} chars)`)
    assert(
      c,
      consoleErrors.length === 0,
      `no console errors during load (${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')})`,
    )

    // Network observability — every /api/ call must go to the local proxy
    // host (rail.uiHandle.url), not directly to the VPS host. This proves
    // the UI doesn't have any hard-coded VPS URLs that would bypass the
    // proxy and break CORS in production.
    info(`captured ${apiRequests.length} /api/ requests`)
    for (const r of apiRequests.slice(0, 6)) {
      info(`  ${String(r.status ?? '???')} ${r.url}`)
    }
    assert(c, apiRequests.length > 0, `browser issued ≥1 /api/* request`)
    const bypassedProxy = apiRequests.filter(r => !r.url.startsWith(rail.uiHandle!.url))
    assert(
      c,
      bypassedProxy.length === 0,
      `every /api/* request went through the local proxy (${bypassedProxy.length} bypassed: ${bypassedProxy.slice(0, 2).map(r => r.url).join(', ')})`,
    )
    const failedApi = apiRequests.filter(r => r.status !== null && r.status >= 400)
    assert(
      c,
      failedApi.length === 0,
      `no 4xx/5xx /api/* responses (${failedApi.length} failed: ${failedApi.slice(0, 2).map(r => `${r.status} ${r.url}`).join(' | ')})`,
    )

    // Final assertion — the runs-list page is the default route. Look for
    // ANY signal it rendered (not the unknown route). The router parses
    // hash; default '#/' = runs-list.
    const url = page.url()
    info(`browser final url: ${url}`)
    assert(c, !appHtml.toLowerCase().includes('unknown route'), `not on the unknown route`)
  } finally {
    await teardown()
  }

  summary('Phase F · F4', c)
  exitFromCounters('Phase F · F4', c)
}

main().catch(async err => {
  console.error('F4 threw:', err)
  await teardown()
  process.exit(1)
})
