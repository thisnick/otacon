/**
 * Phase I · I-Eval-2 — Deployed VPS workspaces lifecycle.
 *
 * Drives the workspaces UI flow against the live VPS:
 *   - List shows the migrated `xhs:test` workspace with phoneNumber set
 *   - Create a new throwaway workspace `social:i-eval-2` via dialog
 *   - Verify side-effect on disk: SSH + `ls /data/orchestrator/workspaces/`
 *   - Edit displayName via Settings tab + PATCH
 *   - Delete via typed-confirm dialog
 *   - Verify side-effect on disk: workspace dir removed
 *
 * The deployed registry has phone-4 online, so we use the registry-backed
 * path of PhoneCombobox (not the free-form fallback that local I-UI2 uses).
 *
 * Run: `pnpm test:e2e:phase-i:eval:2`
 */
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright'

import { VPS_API_BASE, api, ssh } from './helpers/phase-f.js'
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
const NEW_WS_ID = 'social:i-eval-2'
const NEW_WS_PHONE = '+13412137456'

async function teardown(): Promise<void> {
  try { if (rail.browser) await rail.browser.close() } catch { /* ignore */ }
  // Defensive: ensure throwaway workspace is gone even on assertion failure
  // mid-flow. Force-delete swallows 404 / 200 cleanly.
  try {
    await fetch(`${VPS_API_BASE}/api/v1/workspaces/${encodeURIComponent(NEW_WS_ID)}?force=true`, {
      method: 'DELETE',
    })
  } catch { /* ignore */ }
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
  console.log(`\n=== Phase I · I-Eval-2: Deployed workspaces lifecycle (${VPS_API_BASE}) ===`)

  try {
    section('1. Migrated xhs:test surface check (Bucket 2 PATCH applied)')
    const ws = await api<Array<{ id: string; phoneNumber?: string }>>('/api/v1/workspaces')
    assert(c, ws.status === 200, `GET /workspaces → 200`)
    const seeded = (ws.body as Array<{ id: string; phoneNumber?: string }>).find(
      w => w.id === 'xhs:test',
    )
    assert(c, !!seeded, `xhs:test present`)
    assert(
      c,
      seeded?.phoneNumber === NEW_WS_PHONE,
      `xhs:test.phoneNumber set to ${NEW_WS_PHONE} (got ${String(seeded?.phoneNumber)}) — Bucket 2 migration applied`,
    )

    section('2. Pre-clean: ensure throwaway workspace doesn\'t exist from a prior run')
    await fetch(`${VPS_API_BASE}/api/v1/workspaces/${encodeURIComponent(NEW_WS_ID)}?force=true`, {
      method: 'DELETE',
    })

    section('3. Open Workspaces page in browser')
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

    await page.goto(`${VPS_API_BASE}/#/workspaces`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    await page.waitForSelector('[data-testid="workspaces-page"]', { timeout: 10_000 })
    info(`workspaces page mounted`)

    // The migrated xhs:test should be in the table (we asserted via API; UI
    // surface check is a soft signal).
    const tableHtml = await page
      .locator('[data-testid="workspaces-table"]')
      .innerHTML()
      .catch(() => '')
    info(`table-html length: ${tableHtml.length} chars`)
    assert(
      c,
      tableHtml.toLowerCase().includes('xhs:test'),
      `workspaces table renders xhs:test row`,
    )

    section('4. Create new workspace via dialog')
    await page.locator('[data-testid="create-workspace-button"]').click()
    await page.waitForTimeout(300)
    await page.locator('[data-testid="ws-id"]').fill(NEW_WS_ID)
    await page.locator('[data-testid="ws-display-name"]').fill('I-Eval-2 throwaway')

    // Phone via registry-backed path (deployed registry has phones online).
    await page.locator('[data-testid="phone-combobox-trigger"]').click()
    await page.waitForTimeout(200)
    await page.getByPlaceholder('Search phone number...').fill(NEW_WS_PHONE)
    await page.waitForTimeout(300)
    // Either a registry item OR free-form fallback — both end up populating
    // phoneNumber. We prefer the registry item if visible.
    const registryItem = page.locator(`[data-testid^="phone-combobox-item-"]`)
    const freeform = page.locator('[data-testid="phone-combobox-freeform"]')
    if ((await registryItem.count()) > 0) {
      await registryItem.first().click()
      info(`picked registry-backed phone item`)
    } else {
      assert(c, (await freeform.count()) > 0, `phone-combobox shows registry item OR free-form fallback`)
      await freeform.click()
      info(`picked free-form fallback`)
    }
    await page.waitForTimeout(150)
    await page.locator('[data-testid="ws-submit"]').click()

    await page.waitForFunction(
      (id) => window.location.hash.includes(`/workspaces/${encodeURIComponent(id)}`),
      NEW_WS_ID,
      { timeout: 10_000 },
    )
    info(`navigated to detail at ${page.url().split('#')[1]}`)

    section('5. Server side-effect: GET /workspaces/:id returns 200')
    const created = await api<{ id: string; phoneNumber?: string; displayName?: string }>(
      `/api/v1/workspaces/${encodeURIComponent(NEW_WS_ID)}`,
    )
    assert(c, created.status === 200, `GET created workspace → 200`)
    assert(c, created.body.id === NEW_WS_ID, `id matches`)
    assert(c, created.body.phoneNumber === NEW_WS_PHONE, `phoneNumber persisted`)

    section('6. Disk side-effect: workspace dir present on VPS')
    const dirCheck = ssh(`sudo docker exec otacon-orchestrator ls /data/orchestrator/workspaces/ 2>&1`)
    info(`docker exec ls → status=${dirCheck.status}`)
    info(`stdout: ${dirCheck.stdout.trim()}`)
    assert(
      c,
      dirCheck.status === 0 && dirCheck.stdout.includes(NEW_WS_ID),
      `${NEW_WS_ID} dir exists in container's /data/orchestrator/workspaces/`,
    )

    section('7. Edit displayName via Settings tab')
    await page.waitForSelector('[data-testid="workspace-settings-form"]', { timeout: 10_000 })
    await page.locator('[data-testid="ws-settings-display-name"]').fill('I-Eval-2 (renamed)')
    await page.locator('[data-testid="ws-settings-save"]').click()
    await page.waitForTimeout(800)
    const renamed = await api<{ displayName: string }>(
      `/api/v1/workspaces/${encodeURIComponent(NEW_WS_ID)}`,
    )
    assert(c, renamed.body.displayName === 'I-Eval-2 (renamed)', `displayName persisted via PATCH`)

    section('8. Delete workspace via typed-confirm dialog')
    await page.locator('[data-testid="ws-delete-button"]').click()
    await page.waitForTimeout(300)
    await page.locator('[data-testid="confirm-dialog-input"]').fill(NEW_WS_ID)
    await page.locator('[data-testid="confirm-dialog-confirm"]').click()
    await page.waitForFunction(() => window.location.hash === '#/workspaces', undefined, {
      timeout: 10_000,
    })
    info(`navigated back to list`)

    section('9. Server side-effect: workspace gone (404)')
    const afterDelete = await api<unknown>(`/api/v1/workspaces/${encodeURIComponent(NEW_WS_ID)}`)
    assert(c, afterDelete.status === 404, `GET deleted workspace → 404 (got ${afterDelete.status})`)

    section('10. Disk side-effect: workspace dir removed on VPS')
    const dirAfter = ssh(`sudo docker exec otacon-orchestrator ls /data/orchestrator/workspaces/ 2>&1`)
    assert(
      c,
      dirAfter.status === 0 && !dirAfter.stdout.includes(NEW_WS_ID),
      `${NEW_WS_ID} dir removed from container's /data/orchestrator/workspaces/`,
    )
    // xhs:test must still be present (no collateral damage).
    assert(
      c,
      dirAfter.stdout.includes('xhs:test'),
      `xhs:test still present (no collateral damage)`,
    )

    section('11. Console error budget')
    info(`console errors captured: ${consoleErrors.length}`)
    for (const e of consoleErrors.slice(0, 8)) info(`  ${e}`)
    assert(c, consoleErrors.length === 0, `zero non-ignorable console errors`)
  } finally {
    await teardown()
  }

  summary('Phase I · I-Eval-2', c)
  exitFromCounters('Phase I · I-Eval-2', c)
}

main().catch(async err => {
  console.error('I-Eval-2 threw:', err)
  await teardown()
  process.exit(1)
})
