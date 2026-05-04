/**
 * Phase I · I-UI1 — Sidebar nav: 3 items, active highlight, theme toggle.
 *
 * Plan §6.2 / §6.4:
 *   - sidebar-01 block adapted to 3 nav items (Runs / Workspaces / Teams)
 *   - active route highlighted on the matching SidebarMenuButton
 *   - theme toggle exposes Light / Dark / System; Dark adds `.dark` to <html>
 *
 * Boots a fresh local orchestrator + browser; clicks each nav item and
 * verifies the URL hash + that data-state="active" lands on the right
 * SidebarMenuButton. Then exercises the theme toggle and checks the
 * documentElement class flips.
 *
 * Run: `pnpm test:e2e:phase-i:ui:1`
 */
import {
  assertNoConsoleErrors,
  bootUi,
  visit,
} from './helpers/phase-i-ui.js'
import {
  assert,
  exitFromCounters,
  info,
  makeCounters,
  section,
  summary,
} from './helpers/spike.js'

async function main(): Promise<void> {
  const c = makeCounters()
  console.log('\n=== Phase I · I-UI1: Sidebar nav + theme toggle ===')
  const ui = await bootUi({ seed: true })
  info(`server: ${ui.server.baseUrl}`)
  try {
    section('1. Open root, sidebar renders with 3 nav items')
    await visit(ui.page, ui.server.baseUrl, '#/')

    const navRuns = await ui.page.locator('[data-testid="nav-runs"]').count()
    const navWs = await ui.page.locator('[data-testid="nav-workspaces"]').count()
    const navTeams = await ui.page.locator('[data-testid="nav-teams"]').count()
    assert(c, navRuns === 1, `nav-runs present (got ${navRuns})`)
    assert(c, navWs === 1, `nav-workspaces present (got ${navWs})`)
    assert(c, navTeams === 1, `nav-teams present (got ${navTeams})`)

    section('2. Active highlight follows route')
    // On `/` the Runs item should be active.
    const runsActive = await ui.page.locator('[data-testid="nav-runs"][data-active="true"]').count()
    assert(c, runsActive === 1, `Runs nav has data-active=true on /`)

    await ui.page.locator('[data-testid="nav-workspaces"]').click()
    await ui.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
    await ui.page.waitForTimeout(200)
    const wsHash = ui.page.url().split('#')[1] ?? ''
    assert(c, wsHash.startsWith('/workspaces'), `clicking Workspaces moves hash → /workspaces (got ${wsHash})`)
    const wsActive = await ui.page.locator('[data-testid="nav-workspaces"][data-active="true"]').count()
    assert(c, wsActive === 1, `Workspaces nav has data-active=true on /workspaces`)

    await ui.page.locator('[data-testid="nav-teams"]').click()
    await ui.page.waitForTimeout(200)
    const teamsActive = await ui.page.locator('[data-testid="nav-teams"][data-active="true"]').count()
    assert(c, teamsActive === 1, `Teams nav has data-active=true on /teams`)

    await ui.page.locator('[data-testid="nav-runs"]').click()
    await ui.page.waitForTimeout(200)
    const runsActive2 = await ui.page.locator('[data-testid="nav-runs"][data-active="true"]').count()
    assert(c, runsActive2 === 1, `Runs nav re-activates after switching back`)

    section('3. Theme toggle: Light / Dark / System')
    const toggle = ui.page.locator('[data-testid="theme-toggle"]')
    assert(c, (await toggle.count()) === 1, `theme-toggle present`)

    // Dark
    await toggle.click()
    await ui.page.getByRole('menuitem', { name: 'Dark' }).click()
    await ui.page.waitForTimeout(150)
    const isDark = await ui.page.evaluate(() => document.documentElement.classList.contains('dark'))
    assert(c, isDark, `<html> has .dark after picking Dark`)

    // Light
    await toggle.click()
    await ui.page.getByRole('menuitem', { name: 'Light' }).click()
    await ui.page.waitForTimeout(150)
    const isLight = await ui.page.evaluate(() => !document.documentElement.classList.contains('dark'))
    assert(c, isLight, `<html> drops .dark after picking Light`)

    // System
    await toggle.click()
    await ui.page.getByRole('menuitem', { name: 'System' }).click()
    await ui.page.waitForTimeout(150)
    info('theme set to System (visual state depends on OS preference)')

    section('4. Console error budget')
    assertNoConsoleErrors(c, ui.consoleErrors)
  } finally {
    await ui.cleanup()
  }
  summary('Phase I · I-UI1', c)
  exitFromCounters('Phase I · I-UI1', c)
}

main().catch(async (err) => {
  console.error('I-UI1 threw:', err)
  process.exit(1)
})
