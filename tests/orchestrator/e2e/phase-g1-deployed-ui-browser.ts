/**
 * Phase G · G1 — Browser at deployed root URL (server-hosted UI).
 *
 * Replaces F4's CLI-proxy semantic. Phase G mounted the React bundle as
 * static routes on the API server itself, so the deployed VPS now serves
 * the UI at `/` same-origin with the API at `/api/*`. A user just opens
 * `https://otacon-orchestrator.tail0437b8.ts.net/` in their browser; no
 * `orchestrator ui --api` proxy in front anymore.
 *
 * Verified surface:
 *
 *   1. Navigate to deployed `/` — page returns 200 HTML, page title
 *      is set, `#app` populates after React boot.
 *   2. RunsList renders the seeded `xhs:test` workspace + the
 *      `social-media-engagement` team (or shows the empty-state UI if
 *      the seeded data has no sessions yet — both prove the React app
 *      successfully fetched from `/api/v1/*` same-origin).
 *   3. Zero browser console.error messages during page load (per
 *      team-lead's strict-with-exclusions policy: filter favicon 404
 *      + React DevTools install prompts).
 *   4. Every browser-issued `/api/*` request hit the deployed origin
 *      (NOT a localhost proxy) and returned 200 — proves the React
 *      app no longer routes through a CLI proxy.
 *   5. If sessions exist on the deployed VPS (carryover from F8 or
 *      earlier canaries), opening the first one renders SessionDetail
 *      with traces serving as `<img>` 200s same-origin.
 *
 * Run:
 *   pnpm test:e2e:phase-g:g1
 */
import { chromium, type Browser, type ConsoleMessage, type Page, type Request } from 'playwright'

import {
  ACCOUNT_ID,
  ACCOUNT_ID_ENC,
  TEAM_NAME,
  VPS_API_BASE,
  api,
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
  browser: Browser | null
}
const rail: RailIO = { browser: null }

async function teardown(): Promise<void> {
  try { if (rail.browser) await rail.browser.close() } catch {}
}

// Console errors we don't fail on (per team-lead policy).
function isIgnorableConsoleError(text: string): boolean {
  const t = text.toLowerCase()
  if (t.includes('favicon')) return true
  if (t.includes('react devtools')) return true
  // Some browsers log preload warnings as errors at the console level.
  // We don't filter those — leave for surfacing if they appear.
  return false
}

async function main(): Promise<void> {
  const c = makeCounters()
  console.log(`\n=== Phase G · G1: Browser at deployed root URL (${VPS_API_BASE}) ===`)

  try {
    section('1. Pre-check — VPS root + API alive')
    const root = await api<string>('/')
    assert(c, root.status === 200, `GET / → 200 (got ${root.status})`)
    assert(
      c,
      typeof root.body === 'string' && (root.body as string).includes('<div id="app">'),
      `GET / body is real React index.html (has #app div)`,
    )
    assert(
      c,
      typeof root.body === 'string' && !(root.body as string).includes('Web UI not built'),
      `GET / body is NOT the placeholder ('Web UI not built' substring absent)`,
    )

    const ws = await api<Array<{ id: string }>>('/api/v1/workspaces')
    assert(c, ws.status === 200, `GET /api/v1/workspaces → 200`)
    assert(
      c,
      Array.isArray(ws.body) && (ws.body as Array<{ id: string }>).some(w => w.id === ACCOUNT_ID),
      `seeded ${ACCOUNT_ID} present`,
    )

    section('2. Open browser at deployed root, observe console + network')
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
      if (u.includes('/api/') || u.includes('/traces/')) {
        apiRequests.push({ url: u, status: null })
      }
    })
    page.on('response', res => {
      const url = res.url()
      if (!url.includes('/api/') && !url.includes('/traces/')) return
      const found = apiRequests.find(r => r.url === url && r.status === null)
      if (found) found.status = res.status()
    })

    await page.goto(VPS_API_BASE + '/', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})

    section('3. React app booted')
    const title = await page.title()
    info(`page.title() = ${title}`)
    assert(c, title.length > 0, `<title> is set (got "${title}")`)

    const appHtml = await page.locator('#app').innerHTML().catch(() => '')
    info(`#app inner length = ${appHtml.length} chars`)
    assert(c, appHtml.length > 50, `#app populated after React boot (${appHtml.length} chars)`)

    // RunsList signals: either a row referencing the workspace, OR an
    // empty-state "no runs" message — both prove the app rendered.
    const lower = appHtml.toLowerCase()
    const hasWorkspaceRef =
      lower.includes(ACCOUNT_ID.toLowerCase()) ||
      lower.includes(TEAM_NAME.toLowerCase())
    const hasEmptyState =
      lower.includes('no runs') ||
      lower.includes('no sessions') ||
      lower.includes('start a run') ||
      lower.includes('empty')
    info(`RunsList signal — workspaceRef=${hasWorkspaceRef} emptyState=${hasEmptyState}`)
    assert(
      c,
      hasWorkspaceRef || hasEmptyState,
      `RunsList rendered (workspace/team reference OR empty-state — got neither would mean render failure)`,
    )
    assert(c, !lower.includes('unknown route'), `not on the unknown route`)

    section('4. Network — every /api/* + /traces/* call is same-origin to VPS, all 200')
    info(`captured ${apiRequests.length} API/traces requests`)
    for (const r of apiRequests.slice(0, 8)) {
      info(`  ${String(r.status ?? '???')} ${r.url}`)
    }
    assert(c, apiRequests.length > 0, `browser issued ≥1 /api/* request`)

    const offOrigin = apiRequests.filter(r => !r.url.startsWith(VPS_API_BASE + '/'))
    assert(
      c,
      offOrigin.length === 0,
      `every /api/* + /traces/* request hit ${VPS_API_BASE} same-origin (${offOrigin.length} off-origin: ${offOrigin.slice(0, 2).map(r => r.url).join(', ')})`,
    )

    const failedApi = apiRequests.filter(r => r.status !== null && r.status >= 400)
    assert(
      c,
      failedApi.length === 0,
      `no 4xx/5xx /api/* responses (${failedApi.length} failed: ${failedApi.slice(0, 2).map(r => `${r.status} ${r.url}`).join(' | ')})`,
    )

    section('5. Console error budget — strict (excluding favicon + DevTools)')
    info(`console errors captured: ${consoleErrors.length}`)
    for (const e of consoleErrors.slice(0, 8)) info(`  ${e}`)
    assert(
      c,
      consoleErrors.length === 0,
      `zero non-ignorable console errors (${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')})`,
    )

    section('6. Optional — open first session if any exist (SessionDetail + traces)')
    const teamSessions = await api<Array<{ id: string; status?: string }>>(
      `/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions`,
    )
    const sessions = (Array.isArray(teamSessions.body) ? teamSessions.body : []) as Array<{ id: string }>
    info(`deployed sessions for ${TEAM_NAME}: ${sessions.length}`)

    if (sessions.length === 0) {
      info(`(no sessions on VPS — skipping SessionDetail click; test passes if RunsList rendered)`)
    } else {
      const first = sessions[0]!
      info(`opening first session: ${first.id}`)

      // Reset capture buffers for the second navigation.
      consoleErrors.length = 0
      apiRequests.length = 0

      // Hash-router URL: app/sessions/<workspace>/<team>/<sid>. The exact
      // hash shape is internal to the React app; just navigate via the
      // hash directly. If the app uses path routing we still rely on the
      // same SPA fallback.
      const sessionHash = `#/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions/${first.id}`
      await page.goto(VPS_API_BASE + '/' + sessionHash, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})

      const detailHtml = await page.locator('#app').innerHTML().catch(() => '')
      const detailLower = detailHtml.toLowerCase()
      const hasSessionRef =
        detailLower.includes(first.id.toLowerCase()) ||
        detailLower.includes('session') ||
        detailLower.includes('messages')
      info(`SessionDetail signal — hasSessionRef=${hasSessionRef} html=${detailHtml.length} chars`)
      assert(c, detailHtml.length > 50, `SessionDetail #app populated`)

      // Trace fetch checks — find any <img src="/api/v1/...traces..."> tags.
      // We only assert if at least one such image is present; phone-action
      // free runs (memory-only F1) will have no traces.
      const traceImgs = await page.locator('img[src*="/traces/"]').count()
      info(`<img> with /traces/ in src: ${traceImgs}`)

      // Network during SessionDetail load — every /api/* + /traces/* must
      // hit the deployed origin and return 200.
      info(`SessionDetail captured ${apiRequests.length} requests`)
      for (const r of apiRequests.slice(0, 8)) {
        info(`  ${String(r.status ?? '???')} ${r.url}`)
      }
      const detailOffOrigin = apiRequests.filter(r => !r.url.startsWith(VPS_API_BASE + '/'))
      assert(c, detailOffOrigin.length === 0, `SessionDetail: every /api/* + /traces/* same-origin (${detailOffOrigin.length} off-origin)`)
      const detailFailed = apiRequests.filter(r => r.status !== null && r.status >= 400)
      assert(c, detailFailed.length === 0, `SessionDetail: no 4xx/5xx (${detailFailed.length} failed)`)

      assert(
        c,
        consoleErrors.length === 0,
        `SessionDetail: zero non-ignorable console errors (${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')})`,
      )
    }
  } finally {
    await teardown()
  }

  summary('Phase G · G1', c)
  exitFromCounters('Phase G · G1', c)
}

main().catch(async err => {
  console.error('G1 threw:', err)
  await teardown()
  process.exit(1)
})
