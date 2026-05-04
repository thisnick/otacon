/**
 * Phase I · I-UI6 — Start run flow.
 *
 * Plan §5.4 / §6.4 Runs page:
 *   - StartRunDialog has workspace + team + message + auto-approve
 *   - **No phone field** in the form
 *   - On submit, server resolves phoneNumber from the workspace (registry
 *     lookup) and starts an SSE-streamed session
 *
 * Two modes:
 *   - default: drive the form UI through Playwright and verify the
 *     payload that hits POST /api/v1/runs has no `phone` field. Skip
 *     waiting for an actual agent run since that requires phone-4
 *     reachability via the registry.
 *   - PHASE_I_UI6_HARDWARE=1: also waits for the run to land in
 *     /workspaces/:ws/sessions and asserts the session's recorded
 *     workspace matches.
 *
 * Run: `pnpm test:e2e:phase-i:ui:6`
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

const HARDWARE = process.env.PHASE_I_UI6_HARDWARE === '1'
const WS_ID = 'social:i-ui6'
const WS_PHONE = process.env.OTACON_SPIKE_WORKSPACE_PHONE ?? '+13412137456'

async function main(): Promise<void> {
  const c = makeCounters()
  console.log('\n=== Phase I · I-UI6: Start run flow (no phone field) ===')
  if (!HARDWARE) info('hardware-touching scenario skipped (set PHASE_I_UI6_HARDWARE=1 to enable)')
  const ui = await bootUi({ seed: true })
  info(`server: ${ui.server.baseUrl}`)
  try {
    section('1. Seed workspace via API')
    const create = await api(ui.server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: WS_ID,
        displayName: 'I-UI6',
        kind: 'social',
        phoneNumber: WS_PHONE,
      }),
    })
    assert(c, create.status === 201, `POST /workspaces → 201`)

    section('2. Open Runs page + capture POST /runs request')
    await visit(ui.page, ui.server.baseUrl, '#/')
    await ui.page.waitForSelector('[data-testid="start-run-button"]', { timeout: 5_000 })

    const submittedBody: Promise<unknown> = ui.page
      .waitForRequest((req) => {
        return req.method() === 'POST' && req.url().endsWith('/api/v1/runs')
      })
      .then((req) => {
        const post = req.postData()
        return post ? JSON.parse(post) : null
      })

    section('3. Open dialog + verify shape (no phone field)')
    await ui.page.locator('[data-testid="start-run-button"]').click()
    await ui.page.waitForSelector('[data-testid="start-run-form"]', { timeout: 5_000 })
    const formHtml = await ui.page.locator('[data-testid="start-run-form"]').innerHTML()
    assert(c, !formHtml.toLowerCase().includes('phone number'), `form has no "phone number" label`)
    assert(c, !formHtml.toLowerCase().includes('phone-combobox'), `form does not embed PhoneCombobox`)

    section('4. Fill workspace + team + message → submit')
    await ui.page.locator('[data-testid="run-workspace"]').click()
    await ui.page.waitForTimeout(200)
    await ui.page.getByRole('option', { name: new RegExp(WS_ID) }).click()
    await ui.page.waitForTimeout(300)
    await ui.page.locator('[data-testid="run-team"]').click()
    await ui.page.waitForTimeout(200)
    await ui.page.getByRole('option', { name: 'social-media-engagement' }).click()
    await ui.page.locator('[data-testid="run-message"]').fill('I-UI6 test prompt — no agent loop required')
    await ui.page.locator('[data-testid="run-submit"]').click()

    section('5. POST body shape — workspace/team/userMessage/autoApprove only, no phone')
    const body = (await Promise.race([
      submittedBody,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for POST')), 8_000)),
    ])) as Record<string, unknown>
    info(`POST body keys: ${Object.keys(body).sort().join(', ')}`)
    assert(c, typeof body.workspace === 'string', `body.workspace is a string`)
    assert(c, body.workspace === WS_ID, `body.workspace = ${WS_ID}`)
    assert(c, body.team === 'social-media-engagement', `body.team set`)
    assert(c, typeof body.userMessage === 'string', `body.userMessage set`)
    assert(c, !('phone' in body), `body has NO 'phone' field (plan §5.4)`)

    if (HARDWARE) {
      section('6. Hardware mode — wait for session to be recorded')
      // The agent loop will hit phone-4 via the registry. Just poll the
      // workspace's sessions endpoint until at least one session shows up.
      let sessionCount = 0
      for (let i = 0; i < 60; i++) {
        const sl = await api<Array<{ id: string }>>(
          ui.server.baseUrl,
          `/api/v1/workspaces/${encodeURIComponent(WS_ID)}/sessions`,
        )
        sessionCount = sl.body.length
        if (sessionCount > 0) break
        await new Promise((r) => setTimeout(r, 500))
      }
      assert(c, sessionCount > 0, `at least one session recorded for ${WS_ID} (got ${sessionCount})`)
    } else {
      info('skipping hardware-touching session-recording assertion')
    }

    section('7. Console error budget')
    assertNoConsoleErrors(c, ui.consoleErrors)
  } finally {
    await ui.cleanup()
  }
  summary('Phase I · I-UI6', c)
  exitFromCounters('Phase I · I-UI6', c)
}

main().catch((err) => {
  console.error('I-UI6 threw:', err)
  process.exit(1)
})
