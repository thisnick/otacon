/**
 * Phase I · I-UI7 — PhoneCombobox sourced from registry + free-form fallback.
 *
 * Plan §6.5 PhoneCombobox:
 *   - dropdown sourced from `GET /api/v1/phones`
 *   - registry items show E.164 + display label + status
 *   - free-form fallback accepts an arbitrary E.164 typed by the user
 *
 * The local server's `GET /api/v1/phones` proxies the registry. When
 * OTACON_REGISTRY_URL + admin token are present (which is true in dev),
 * registry-backed entries should appear. We test both paths:
 *   - registry-backed pick: the seeded phone-4 number
 *   - free-form fallback: type a number absent from the registry result
 *
 * Run: `pnpm test:e2e:phase-i:ui:7`
 */
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

interface PhoneEntry {
  phoneNumber: string
  status: string
  registryId: string
  displayLabel: string
  hostId: string
}

const FREEFORM_NUMBER = '+15555550107'

async function main(): Promise<void> {
  const c = makeCounters()
  console.log('\n=== Phase I · I-UI7: PhoneCombobox ===')
  const ui = await bootUi({ seed: true })
  info(`server: ${ui.server.baseUrl}`)
  try {
    section('1. Server provides /api/v1/phones')
    const phones = await api<PhoneEntry[]>(ui.server.baseUrl, '/api/v1/phones')
    assert(c, phones.status === 200, `GET /phones → 200`)
    assert(c, Array.isArray(phones.body), `body is an array`)
    info(`registry phones (${phones.body.length}): ${phones.body.map((p) => p.phoneNumber).slice(0, 3).join(', ')}`)

    section('2. Open Workspaces create dialog → click PhoneCombobox')
    await visit(ui.page, ui.server.baseUrl, '#/workspaces')
    await ui.page.waitForSelector('[data-testid="create-workspace-button"]', { timeout: 5_000 })
    await ui.page.locator('[data-testid="create-workspace-button"]').click()
    await ui.page.waitForSelector('[data-testid="phone-combobox-trigger"]', { timeout: 5_000 })
    await ui.page.locator('[data-testid="phone-combobox-trigger"]').click()
    await ui.page.waitForTimeout(300)

    if (phones.body.length > 0) {
      section('3a. Registry-backed: pick the first registry phone')
      // Items render with data-testid="phone-combobox-item-<phoneNumber>".
      const first = phones.body[0]!
      const item = ui.page.locator(`[data-testid="phone-combobox-item-${first.phoneNumber}"]`)
      await item.waitFor({ timeout: 3_000 }).catch(() => undefined)
      const itemCount = await item.count()
      assert(c, itemCount === 1, `registry item ${first.phoneNumber} present`)
      await item.click()
      await ui.page.waitForTimeout(200)
      const triggerHtml = await ui.page.locator('[data-testid="phone-combobox-trigger"]').innerHTML()
      assert(
        c,
        triggerHtml.includes(first.phoneNumber) || triggerHtml.includes(first.displayLabel),
        `trigger updates to show selected phone`,
      )
    } else {
      info('skipping 3a — no registry phones available in this environment')
    }

    section('3b. Free-form fallback: type a number not in the registry')
    await ui.page.locator('[data-testid="phone-combobox-trigger"]').click()
    await ui.page.waitForTimeout(200)
    const search = ui.page.getByPlaceholder('Search phone number...')
    await search.fill(FREEFORM_NUMBER)
    await ui.page.waitForTimeout(200)
    // cmdk's empty state with our "Use ... anyway" CTA.
    const freeform = ui.page.locator('[data-testid="phone-combobox-freeform"]')
    const freeformCount = await freeform.count()
    assert(c, freeformCount === 1, `free-form CTA shown for non-registry number`)
    await freeform.click()
    await ui.page.waitForTimeout(200)
    const triggerHtml2 = await ui.page.locator('[data-testid="phone-combobox-trigger"]').innerHTML()
    assert(c, triggerHtml2.includes(FREEFORM_NUMBER), `trigger reflects the typed-in number`)

    section('4. Console error budget')
    assertNoConsoleErrors(c, ui.consoleErrors)
  } finally {
    await ui.cleanup()
  }
  summary('Phase I · I-UI7', c)
  exitFromCounters('Phase I · I-UI7', c)
}

main().catch((err) => {
  console.error('I-UI7 threw:', err)
  process.exit(1)
})
