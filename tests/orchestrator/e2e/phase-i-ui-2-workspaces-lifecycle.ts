/**
 * Phase I · I-UI2 — Workspaces full lifecycle.
 *
 * list → create (via dialog) → detail Settings (PATCH) → delete (typed-confirm).
 *
 * Plan §6.4 maps each surface; this scenario walks them end-to-end with
 * Playwright and verifies the on-disk file tree mutates as expected via
 * the helper `dataRoot`.
 *
 * Run: `pnpm test:e2e:phase-i:ui:2`
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  api,
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

interface Workspace {
  id: string
  displayName: string
  kind: string
  phoneNumber?: string
  externalRef?: string
  createdAt: number
}

const NEW_WS_ID = 'social:i-ui2'
const NEW_WS_PHONE = '+15555550199'

async function main(): Promise<void> {
  const c = makeCounters()
  console.log('\n=== Phase I · I-UI2: Workspaces lifecycle ===')
  const ui = await bootUi({ seed: true })
  info(`server: ${ui.server.baseUrl}`)
  try {
    section('1. Workspaces list — empty state on a fresh install')
    await visit(ui.page, ui.server.baseUrl, '#/workspaces')
    const wsPage = await ui.page.locator('[data-testid="workspaces-page"]').count()
    assert(c, wsPage === 1, `workspaces-page mounted`)
    // Seeded server starts with NO workspaces (seed.ts creates only teams).
    const tableEmpty = await ui.page.locator('[data-testid="workspaces-table"]').count()
    assert(c, tableEmpty === 0, `no table on a fresh install`)

    section('2. Create new workspace via dialog')
    await ui.page.locator('[data-testid="create-workspace-button"]').click()
    await ui.page.waitForTimeout(200)
    await ui.page.locator('[data-testid="ws-id"]').fill(NEW_WS_ID)
    await ui.page.locator('[data-testid="ws-display-name"]').fill('I-UI2 Test')

    // Phone via free-form (registry has no phones online in this test env).
    await ui.page.locator('[data-testid="phone-combobox-trigger"]').click()
    await ui.page.waitForTimeout(150)
    // The free-form fallback button only appears once the user types into
    // CommandInput. cmdk only renders matches; we type the full E.164 so the
    // empty-state shows the "Use ... anyway" affordance.
    await ui.page.getByPlaceholder('Search phone number...').fill(NEW_WS_PHONE)
    await ui.page.waitForTimeout(150)
    const freeformVisible = await ui.page.locator('[data-testid="phone-combobox-freeform"]').count()
    if (freeformVisible > 0) {
      await ui.page.locator('[data-testid="phone-combobox-freeform"]').click()
    } else {
      // Phone happens to match a registry entry — pick the first item.
      await ui.page.locator(`[data-testid^="phone-combobox-item-"]`).first().click()
    }
    await ui.page.waitForTimeout(150)
    await ui.page.locator('[data-testid="ws-submit"]').click()
    // Navigates to detail on success.
    await ui.page.waitForFunction(
      () => window.location.hash.includes('/workspaces/social%3Ai-ui2'),
      undefined,
      { timeout: 5_000 },
    )
    info(`navigated to detail at ${ui.page.url().split('#')[1]}`)

    section('3. Server side-effect: workspace.json on disk + GET /workspaces returns 1 row')
    const wsListR = await api<Workspace[]>(ui.server.baseUrl, '/api/v1/workspaces')
    assert(c, wsListR.status === 200, `GET /workspaces → 200`)
    const list = wsListR.body
    assert(c, Array.isArray(list) && list.length === 1, `list has 1 workspace (got ${list.length})`)
    assert(c, list[0]?.id === NEW_WS_ID, `id = ${NEW_WS_ID}`)
    const fsPath = path.join(ui.server.dataRoot, 'workspaces', NEW_WS_ID, 'workspace.json')
    assert(c, fs.existsSync(fsPath), `workspace.json on disk at ${fsPath}`)

    section('4. Detail page renders Settings tab + form')
    await ui.page.waitForSelector('[data-testid="workspace-settings-form"]', { timeout: 5_000 })
    const settingsForm = await ui.page.locator('[data-testid="workspace-settings-form"]').count()
    assert(c, settingsForm === 1, `settings form rendered`)

    section('5. Edit displayName via PATCH')
    await ui.page.locator('[data-testid="ws-settings-display-name"]').fill('I-UI2 Test (renamed)')
    await ui.page.locator('[data-testid="ws-settings-save"]').click()
    await ui.page.waitForTimeout(500)
    const after = (await api<Workspace>(ui.server.baseUrl, `/api/v1/workspaces/${encodeURIComponent(NEW_WS_ID)}`)).body
    assert(c, after.displayName === 'I-UI2 Test (renamed)', `displayName persisted on disk`)

    section('6. Delete (typed-confirm) — clean workspace with no sessions')
    await ui.page.locator('[data-testid="ws-delete-button"]').click()
    await ui.page.waitForTimeout(200)
    await ui.page.locator('[data-testid="confirm-dialog-input"]').fill(NEW_WS_ID)
    await ui.page.locator('[data-testid="confirm-dialog-confirm"]').click()
    await ui.page.waitForFunction(() => window.location.hash === '#/workspaces', undefined, {
      timeout: 5_000,
    })
    info(`navigated back to list at ${ui.page.url().split('#')[1]}`)

    section('7. Server side-effect: workspace.json removed + list empty')
    const afterDelete = await api<Workspace[]>(ui.server.baseUrl, '/api/v1/workspaces')
    assert(c, Array.isArray(afterDelete.body) && afterDelete.body.length === 0, `list is empty after delete`)
    assert(c, !fs.existsSync(fsPath), `workspace.json removed`)

    section('8. Console error budget')
    assertNoConsoleErrors(c, ui.consoleErrors)
  } finally {
    await ui.cleanup()
  }
  summary('Phase I · I-UI2', c)
  exitFromCounters('Phase I · I-UI2', c)
}

main().catch((err) => {
  console.error('I-UI2 threw:', err)
  process.exit(1)
})
