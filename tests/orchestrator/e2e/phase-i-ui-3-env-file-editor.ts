/**
 * Phase I · I-UI3 — Env file editor: edit `persona.md`, save, refresh, content persists.
 *
 * Plan §6.4 Env files tab:
 *   - per-file `<Card>` with markdown textarea
 *   - Save button calls PUT /workspaces/:id/env/:file
 *   - On refresh the new content reads back from disk
 *
 * Run: `pnpm test:e2e:phase-i:ui:3`
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

const WS_ID = 'social:i-ui3'
const WS_PHONE = '+15555550103'
const NEW_PERSONA = 'I-UI3 persona content — saved by Playwright.\n'

async function main(): Promise<void> {
  const c = makeCounters()
  console.log('\n=== Phase I · I-UI3: Env file editor persistence ===')
  const ui = await bootUi({ seed: true })
  info(`server: ${ui.server.baseUrl}`)
  try {
    section('1. Seed: create a workspace via API to skip the dialog')
    const create = await api(ui.server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: WS_ID,
        displayName: 'I-UI3',
        kind: 'social',
        phoneNumber: WS_PHONE,
      }),
    })
    assert(c, create.status === 201, `POST /workspaces → 201 (got ${create.status})`)

    section('2. Open detail → Env tab')
    await visit(ui.page, ui.server.baseUrl, `#/workspaces/${encodeURIComponent(WS_ID)}?tab=env`)
    await ui.page.waitForSelector('[data-testid="env-tab"]', { timeout: 5_000 })

    const personaCard = await ui.page.locator('[data-testid="env-card-persona.md"]').count()
    const soulCard = await ui.page.locator('[data-testid="env-card-soul.md"]').count()
    const memoryCard = await ui.page.locator('[data-testid="env-card-memory.md"]').count()
    assert(c, personaCard === 1, `persona.md card present`)
    assert(c, soulCard === 1, `soul.md card present`)
    assert(c, memoryCard === 1, `memory.md card present`)

    section('3. Edit persona.md + Save')
    const textarea = ui.page.locator('[data-testid="env-textarea-persona.md"]')
    await textarea.fill(NEW_PERSONA)
    await ui.page.locator('[data-testid="env-save-persona.md"]').click()
    await ui.page.waitForTimeout(500)

    section('4. Server side-effect: GET text returns new content')
    const fetched = await fetch(
      `${ui.server.baseUrl}/api/v1/workspaces/${encodeURIComponent(WS_ID)}/env/persona.md`,
    )
    const text = await fetched.text()
    assert(c, fetched.status === 200, `GET env/persona.md → 200`)
    assert(c, text === NEW_PERSONA, `persisted content matches (got ${JSON.stringify(text.slice(0, 40))}...)`)

    section('5. Hard reload, content survives + dirty flag clears')
    await ui.page.reload()
    await ui.page.waitForSelector('[data-testid="env-textarea-persona.md"]', { timeout: 5_000 })
    const textareaAfterReload = ui.page.locator('[data-testid="env-textarea-persona.md"]')
    const value = await textareaAfterReload.inputValue()
    assert(c, value === NEW_PERSONA, `after reload, textarea reads back the saved content`)
    // Dirty marker = "unsaved" string in the card title; should be absent.
    const html = await ui.page.locator('[data-testid="env-card-persona.md"]').innerHTML()
    assert(c, !html.toLowerCase().includes('unsaved'), `no unsaved marker after reload`)

    section('6. Console error budget')
    assertNoConsoleErrors(c, ui.consoleErrors)
  } finally {
    await ui.cleanup()
  }
  summary('Phase I · I-UI3', c)
  exitFromCounters('Phase I · I-UI3', c)
}

main().catch((err) => {
  console.error('I-UI3 threw:', err)
  process.exit(1)
})
