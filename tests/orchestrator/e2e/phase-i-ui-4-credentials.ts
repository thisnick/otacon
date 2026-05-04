/**
 * Phase I · I-UI4 — Credentials write-only flow.
 *
 * Plan §6.4 Credentials tab + §5.2:
 *   - PUT body is opaque JSON; server stores as-is
 *   - GET returns `{hasCredentials, fieldsSet}` only — never values
 *   - UI textarea is never pre-populated; status alert reflects fieldsSet
 *
 * Run: `pnpm test:e2e:phase-i:ui:4`
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

interface Status {
  hasCredentials: boolean
  fieldsSet: string[]
}

const WS_ID = 'social:i-ui4'
const WS_PHONE = '+15555550104'
const SECRET = { cookies: 'session=abc123', deviceId: 'pixel-5', ua: 'Mozilla/5.0' }

async function main(): Promise<void> {
  const c = makeCounters()
  console.log('\n=== Phase I · I-UI4: Credentials write-only ===')
  const ui = await bootUi({ seed: true })
  info(`server: ${ui.server.baseUrl}`)
  try {
    section('1. Seed: workspace via API')
    const create = await api(ui.server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: WS_ID,
        displayName: 'I-UI4',
        kind: 'social',
        phoneNumber: WS_PHONE,
      }),
    })
    assert(c, create.status === 201, `POST /workspaces → 201`)

    section('2. Open Credentials tab — empty state')
    await visit(ui.page, ui.server.baseUrl, `#/workspaces/${encodeURIComponent(WS_ID)}?tab=credentials`)
    await ui.page.waitForSelector('[data-testid="credentials-tab"]', { timeout: 5_000 })

    const html0 = await ui.page.locator('[data-testid="credentials-tab"]').innerHTML()
    assert(c, html0.toLowerCase().includes('no credentials'), `status alert says "No credentials"`)

    const ta = ui.page.locator('[data-testid="credentials-textarea"]')
    const initVal = await ta.inputValue()
    assert(c, initVal === '', `textarea is empty (write-only — never pre-populated)`)

    section('3. Save credentials')
    await ta.fill(JSON.stringify(SECRET, null, 2))
    await ui.page.locator('[data-testid="credentials-validate"]').click()
    await ui.page.waitForTimeout(150)
    await ui.page.locator('[data-testid="credentials-save"]').click()
    await ui.page.waitForTimeout(700)

    section('4. Server status reflects the saved fields')
    const status = await api<Status>(
      ui.server.baseUrl,
      `/api/v1/workspaces/${encodeURIComponent(WS_ID)}/credentials`,
    )
    assert(c, status.status === 200, `GET credentials → 200`)
    assert(c, status.body.hasCredentials === true, `hasCredentials = true`)
    assert(c, Array.isArray(status.body.fieldsSet), `fieldsSet is an array`)
    const expectedKeys = Object.keys(SECRET).sort()
    const got = [...status.body.fieldsSet].sort()
    assert(
      c,
      JSON.stringify(got) === JSON.stringify(expectedKeys),
      `fieldsSet matches (got ${JSON.stringify(got)})`,
    )

    section('5. UI status alert updates + textarea clears')
    await ui.page.waitForTimeout(500)
    const html1 = await ui.page.locator('[data-testid="credentials-tab"]').innerHTML()
    assert(c, html1.toLowerCase().includes('credentials set'), `status alert flipped to "Credentials set"`)
    for (const k of expectedKeys) {
      assert(c, html1.includes(k), `field name ${k} listed`)
    }
    // Body must NOT echo the values.
    const cookieVal = SECRET.cookies
    assert(c, !html1.includes(cookieVal), `tab body does not leak the cookie value`)

    section('6. GET response itself does NOT include values')
    const raw = (await fetch(
      `${ui.server.baseUrl}/api/v1/workspaces/${encodeURIComponent(WS_ID)}/credentials`,
    )).status
    const txt = JSON.stringify(status.body)
    assert(c, raw === 200, `endpoint reachable`)
    assert(c, !txt.includes(cookieVal), `JSON response does not leak the cookie value`)
    assert(c, !txt.includes('Mozilla'), `JSON response does not leak the user-agent value`)

    section('7. Wipe credentials')
    await ui.page.locator('[data-testid="credentials-wipe"]').click()
    await ui.page.waitForTimeout(200)
    await ui.page.locator('[data-testid="confirm-dialog-confirm"]').click()
    await ui.page.waitForTimeout(700)
    const after = await api<Status>(
      ui.server.baseUrl,
      `/api/v1/workspaces/${encodeURIComponent(WS_ID)}/credentials`,
    )
    assert(c, after.body.hasCredentials === false, `hasCredentials = false after wipe`)
    assert(c, after.body.fieldsSet.length === 0, `fieldsSet empty after wipe`)

    section('8. Console error budget')
    assertNoConsoleErrors(c, ui.consoleErrors)
  } finally {
    await ui.cleanup()
  }
  summary('Phase I · I-UI4', c)
  exitFromCounters('Phase I · I-UI4', c)
}

main().catch((err) => {
  console.error('I-UI4 threw:', err)
  process.exit(1)
})
