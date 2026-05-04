/**
 * Phase I · I-Eval-1 — Deployed VPS sidebar + theme + console budget.
 *
 * Replaces Phase G's G1 for the Phase I sign-off (per evaluator plan and
 * lead Q2 confirmation): the React+shadcn rebuild lands on the deployed
 * VPS and we verify it renders correctly same-origin.
 *
 * Verified surface:
 *   1. GET / → 200 with the React index.html (`<div id="app">`)
 *   2. AppSidebar mounts with all 3 nav items (data-testid=nav-{runs,workspaces,teams})
 *   3. Theme toggle picker opens; clicking Dark adds `.dark` to <html>
 *   4. Every browser-issued /api/* request hits VPS same-origin and returns 2xx
 *   5. Zero non-ignorable console errors / pageerrors during page boot
 *      (ignorable: favicon 404, React DevTools, vite HMR — same policy as G1)
 *
 * Run: `pnpm test:e2e:phase-i:eval:1`
 */
import { chromium, type Browser, type ConsoleMessage, type Page, type Request } from 'playwright'

import { VPS_API_BASE, api } from './helpers/phase-f.js'
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
  try { if (rail.browser) await rail.browser.close() } catch { /* ignore */ }
}

function isIgnorableConsoleError(text: string): boolean {
  const t = text.toLowerCase()
  if (t.includes('favicon')) return true
  if (t.includes('react devtools')) return true
  if (t.includes('vite')) return true
  return false
}

async function main(): Promise<void> {
  const c = makeCounters()
  console.log(`\n=== Phase I · I-Eval-1: Deployed sidebar + theme (${VPS_API_BASE}) ===`)

  try {
    section('1. Pre-check — VPS root + API alive')
    const root = await api<string>('/')
    assert(c, root.status === 200, `GET / → 200 (got ${root.status})`)
    assert(
      c,
      typeof root.body === 'string' && (root.body as string).includes('<div id="app">'),
      `GET / body is React index.html (#app present)`,
    )

    const ws = await api<Array<{ id: string }>>('/api/v1/workspaces')
    assert(c, ws.status === 200, `GET /api/v1/workspaces → 200`)

    section('2. Open browser at deployed root')
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
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)

    section('3. AppSidebar — 3 nav items present')
    await page.waitForSelector('[data-testid="nav-runs"]', { timeout: 10_000 })
    const navRuns = await page.locator('[data-testid="nav-runs"]').count()
    const navWs = await page.locator('[data-testid="nav-workspaces"]').count()
    const navTeams = await page.locator('[data-testid="nav-teams"]').count()
    assert(c, navRuns === 1, `nav-runs present (got ${navRuns})`)
    assert(c, navWs === 1, `nav-workspaces present (got ${navWs})`)
    assert(c, navTeams === 1, `nav-teams present (got ${navTeams})`)

    section('4. Theme toggle — Dark adds .dark to <html>')
    const toggle = page.locator('[data-testid="theme-toggle"]')
    assert(c, (await toggle.count()) === 1, `theme-toggle present`)
    await toggle.click()
    await page.getByRole('menuitem', { name: 'Dark' }).click()
    await page.waitForTimeout(200)
    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
    assert(c, isDark, `<html> has .dark after picking Dark`)
    // Reset to System so we don't pollute downstream scenarios.
    await toggle.click()
    await page.getByRole('menuitem', { name: 'System' }).click()
    await page.waitForTimeout(150)

    section('5. Network — every /api/* request hit VPS same-origin and 2xx')
    info(`captured ${apiRequests.length} /api/* requests`)
    for (const r of apiRequests.slice(0, 8)) {
      info(`  ${String(r.status ?? '???')} ${r.url}`)
    }
    assert(c, apiRequests.length > 0, `browser issued ≥1 /api/* request (got ${apiRequests.length})`)
    const offOrigin = apiRequests.filter(r => !r.url.startsWith(VPS_API_BASE + '/'))
    assert(
      c,
      offOrigin.length === 0,
      `every /api/* request hit ${VPS_API_BASE} same-origin (${offOrigin.length} off-origin: ${offOrigin.slice(0, 2).map(r => r.url).join(', ')})`,
    )
    const failedApi = apiRequests.filter(r => r.status !== null && r.status >= 400)
    assert(
      c,
      failedApi.length === 0,
      `no 4xx/5xx /api/* responses (${failedApi.length} failed: ${failedApi.slice(0, 2).map(r => `${r.status} ${r.url}`).join(' | ')})`,
    )

    section('6. Console error budget')
    info(`console errors captured: ${consoleErrors.length}`)
    for (const e of consoleErrors.slice(0, 8)) info(`  ${e}`)
    assert(
      c,
      consoleErrors.length === 0,
      `zero non-ignorable console errors (${consoleErrors.length})`,
    )
  } finally {
    await teardown()
  }

  summary('Phase I · I-Eval-1', c)
  exitFromCounters('Phase I · I-Eval-1', c)
}

main().catch(async err => {
  console.error('I-Eval-1 threw:', err)
  await teardown()
  process.exit(1)
})
