/**
 * Phase I · I-Eval-4 — Deployed VPS run flow with hardware (phone-4 + XHS).
 *
 * The canonical Phase I behavior change is dropping the `phone` field from
 * `POST /api/v1/runs`. This scenario drives the New Run dialog in the UI
 * against the deployed VPS, intercepts the POST body to confirm it has no
 * `phone` field, then waits for the run to complete via SSE (server-side
 * resolves phone-4 from `xhs:test.phoneNumber`).
 *
 * Verified surface:
 *   1. UI Runs page mounts; "+ Start new run" dialog has NO phone field
 *   2. POST /api/v1/runs body keys: workspace, team, userMessage,
 *      autoApprove (and NO `phone`)
 *   3. SSE stream completes with terminal `agent_end` + `[DONE]` sentinel
 *   4. P5 false-pass guards: turnCount > 0, finalText non-empty, status =
 *      "completed", expected v7 chunk types (text_start/text_delta/text_end,
 *      message_update outer, etc.)
 *   5. session.json on disk records the run + ≥1 phone_action with all 3
 *      screenshot URLs serving 200 (proves agent actually drove the phone)
 *
 * This is the hardware-touching scenario for Phase I (canonical XHS prompt).
 * Single phone-4 lock — must NOT run in parallel with I-Eval-6 (also XHS).
 *
 * Run: `pnpm test:e2e:phase-i:eval:4`
 */
import { chromium, type Browser, type ConsoleMessage, type Page, type Request as PWRequest } from 'playwright'

import {
  ACCOUNT_ID,
  ACCOUNT_ID_ENC,
  TEAM_NAME,
  VPS_API_BASE,
  api,
  countTurns,
  extractFinalText,
  extractInnerEventTypes,
  extractPhoneActions,
  fetchBytes,
  postRunAndConsume,
  traceUrl,
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

const I_EVAL_4_PROMPT =
  process.env.OTACON_I_EVAL_4_PROMPT ??
  'open Xiaohongshu (com.xingin.xhs) and scroll the home feed once, then exit. Tell me what you saw in one sentence.'
const I_EVAL_4_TIMEOUT_MS = Number(process.env.OTACON_I_EVAL_4_TIMEOUT_MS ?? 25 * 60_000)

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function looksLikePng(b: Uint8Array): boolean {
  if (b.length < 8) return false
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_MAGIC[i]) return false
  return true
}

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
  console.log(`\n=== Phase I · I-Eval-4: Deployed run flow with hardware (${VPS_API_BASE}) ===`)
  console.log(`prompt = ${I_EVAL_4_PROMPT}`)

  // ---------------------------------------------------------------------------
  // PART 1 — UI surface check + POST body shape via Playwright.
  // We intercept the request, capture the body, then ABORT the request before
  // it reaches the server. This avoids spawning two competing agent runs
  // (the SSE-driven run from PART 2 is the canonical one we wait on).
  // ---------------------------------------------------------------------------

  let postBody: Record<string, unknown> | null = null

  try {
    section('1. UI surface — open New Run dialog, intercept POST shape, abort')
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

    // Route POST /api/v1/runs: capture the body, then abort so no real run
    // kicks off from the UI side.
    await page.route('**/api/v1/runs', async (route, req: PWRequest) => {
      if (req.method() !== 'POST') return route.continue()
      try {
        const post = req.postData()
        if (post) postBody = JSON.parse(post) as Record<string, unknown>
      } catch { /* ignore */ }
      await route.abort()
    })

    await page.goto(`${VPS_API_BASE}/#/`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    await page.waitForSelector('[data-testid="start-run-button"]', { timeout: 10_000 })

    await page.locator('[data-testid="start-run-button"]').click()
    await page.waitForSelector('[data-testid="start-run-form"]', { timeout: 10_000 })

    const formHtml = await page.locator('[data-testid="start-run-form"]').innerHTML()
    assert(c, !formHtml.toLowerCase().includes('phone number'), `dialog has no "phone number" label`)
    assert(c, !formHtml.toLowerCase().includes('phone-combobox'), `dialog does not embed PhoneCombobox`)

    // Pick xhs:test workspace + social-media-engagement team.
    await page.locator('[data-testid="run-workspace"]').click()
    await page.waitForTimeout(300)
    await page.getByRole('option', { name: new RegExp(ACCOUNT_ID) }).click()
    await page.waitForTimeout(400)
    await page.locator('[data-testid="run-team"]').click()
    await page.waitForTimeout(300)
    await page.getByRole('option', { name: TEAM_NAME }).click()
    await page.locator('[data-testid="run-message"]').fill('I-Eval-4 dialog probe — POST will be aborted')
    await page.locator('[data-testid="run-submit"]').click()

    // Wait briefly for the route handler to capture the body.
    for (let i = 0; i < 40 && postBody === null; i++) {
      await page.waitForTimeout(100)
    }

    info(`POST body keys: ${postBody ? Object.keys(postBody).sort().join(', ') : '(none captured)'}`)
    assert(c, postBody !== null, `POST /api/v1/runs body captured by route handler`)
    if (postBody) {
      assert(c, typeof postBody.workspace === 'string', `body.workspace is a string`)
      assert(c, postBody.workspace === ACCOUNT_ID, `body.workspace = ${ACCOUNT_ID}`)
      assert(c, postBody.team === TEAM_NAME, `body.team = ${TEAM_NAME}`)
      assert(c, typeof postBody.userMessage === 'string', `body.userMessage set`)
      assert(c, !('phone' in postBody), `body has NO 'phone' field (plan §5.4)`)
    }

    info(`UI console errors: ${consoleErrors.length}`)
    assert(c, consoleErrors.length === 0, `zero non-ignorable console errors during dialog drive`)
  } finally {
    if (rail.browser) {
      try { await rail.browser.close() } catch { /* ignore */ }
      rail.browser = null
    }
  }

  // ---------------------------------------------------------------------------
  // PART 2 — Drive the canonical XHS run via the same POST shape (no phone
  // field), wait for SSE terminal, verify P5 guards + phone_action traces.
  // This is the same surface the UI's submit eventually drives; we run it
  // directly because Playwright SSE consumption is fragile and the route-
  // abort above already proves the UI submit shape is correct.
  // ---------------------------------------------------------------------------

  section('2. POST /api/v1/runs (no phone field) → consume SSE stream')
  const t0 = Date.now()
  const run = await postRunAndConsume(
    {
      workspace: ACCOUNT_ID,
      team: TEAM_NAME,
      userMessage: I_EVAL_4_PROMPT,
      resume: 'new',
      autoApprove: true,
    },
    { timeoutMs: I_EVAL_4_TIMEOUT_MS },
  )
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  info(`elapsed: ${elapsed}s; events=${run.events.length}; sid=${run.sessionId ?? '(none)'}`)
  info(`terminal kind: ${run.terminal?.payload ? JSON.stringify((run.terminal.payload['event'] as Record<string, unknown> | undefined)?.['type']) : 'none'}`)
  info(`[DONE] sentinel: ${run.doneSentinel}`)

  assert(c, run.httpStatus === 200, `POST /runs → 200 (got ${run.httpStatus})`)
  assert(
    c,
    typeof run.sessionId === 'string' && run.sessionId.length === 26,
    `x-orchestrator-session-id is a 26-char ULID (got ${String(run.sessionId)})`,
  )
  assert(c, run.doneSentinel, `[DONE] sentinel observed`)
  assert(c, run.terminal !== null, `terminal pi event observed`)
  if (run.terminal?.payload) {
    const inner = run.terminal.payload['event'] as Record<string, unknown> | undefined
    assert(c, inner?.['type'] === 'agent_end', `terminal pi event type = agent_end (got ${String(inner?.['type'])})`)
  }

  section('3. P5 false-pass guards')
  const turnCount = countTurns(run.events)
  const finalText = extractFinalText(run.events)
  info(`turnCount = ${turnCount}`)
  info(`finalText length = ${finalText.length} chars`)
  if (finalText.length > 0) info(`finalText preview: ${finalText.slice(0, 200)}${finalText.length > 200 ? '…' : ''}`)
  assert(c, turnCount > 0, `turnCount > 0 (got ${turnCount}) — P5 false-pass guard`)
  assert(c, finalText.length > 0, `finalText non-empty (length ${finalText.length}) — P5 false-pass guard`)

  // Outer + inner v7 chunk types.
  const outerChunkTypes = new Set<string>()
  for (const e of run.events) {
    if (e.payload && e.payload['kind'] === 'pi') {
      const inner = e.payload['event'] as Record<string, unknown> | undefined
      if (inner && typeof inner['type'] === 'string') outerChunkTypes.add(inner['type'])
    }
  }
  const innerChunkTypes = extractInnerEventTypes(run.events)
  info(`outer pi event types: ${Array.from(outerChunkTypes).sort().join(', ')}`)
  info(`inner assistantMessageEvent types: ${Array.from(innerChunkTypes).sort().join(', ')}`)
  assert(c, outerChunkTypes.has('agent_start'), `outer agent_start present`)
  assert(c, outerChunkTypes.has('agent_end'), `outer agent_end present`)
  assert(c, outerChunkTypes.has('turn_start'), `outer turn_start present`)
  assert(c, outerChunkTypes.has('turn_end'), `outer turn_end present`)
  assert(c, outerChunkTypes.has('message_update'), `outer message_update present`)
  assert(
    c,
    outerChunkTypes.has('tool_execution_start'),
    `outer tool_execution_start present (phone tool was called)`,
  )
  assert(
    c,
    innerChunkTypes.has('text_delta') || innerChunkTypes.has('text_start'),
    `inner text streaming present (text_start or text_delta) — got [${Array.from(innerChunkTypes).join(', ')}]`,
  )

  section('4. session.json status = completed')
  if (run.sessionId) {
    const meta = await api<{ status?: string; endedAt?: number | null }>(
      `/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions/${run.sessionId}`,
    )
    assert(c, meta.status === 200, `GET session → 200`)
    const m = meta.body as { status?: string; endedAt?: number | null }
    assert(c, m.status === 'completed', `session.status = "completed" (got "${m.status}")`)
    assert(
      c,
      typeof m.endedAt === 'number' && (m.endedAt as number) > 0,
      `session.endedAt > 0 (got ${String(m.endedAt)})`,
    )
  }

  section('5. ≥1 phone_action with all 3 screenshot URLs serving 200')
  const actions = extractPhoneActions(run.events)
  info(`phone_actions in stream: ${actions.length}`)
  assert(c, actions.length >= 1, `≥1 phone_action observed (got ${actions.length})`)
  if (actions.length >= 1 && run.sessionId) {
    const a = actions[0]!
    info(`first action: ${a.command} ${a.subcommand} (toolCallId=${a.toolCallId})`)
    const before = traceUrl(ACCOUNT_ID, TEAM_NAME, run.sessionId, a.toolCallId, 'before.png')
    const annotated = traceUrl(ACCOUNT_ID, TEAM_NAME, run.sessionId, a.toolCallId, 'annotated.png')
    const after = traceUrl(ACCOUNT_ID, TEAM_NAME, run.sessionId, a.toolCallId, 'after.png')
    const [b, an, af] = await Promise.all([fetchBytes(before), fetchBytes(annotated), fetchBytes(after)])
    info(`before.png status=${b.status} bytes=${b.bytes.length}`)
    info(`annotated.png status=${an.status} bytes=${an.bytes.length}`)
    info(`after.png status=${af.status} bytes=${af.bytes.length}`)
    assert(c, b.status === 200 && looksLikePng(b.bytes), `before.png → 200 + PNG magic`)
    assert(c, an.status === 200 && looksLikePng(an.bytes), `annotated.png → 200 + PNG magic`)
    assert(c, af.status === 200 && looksLikePng(af.bytes), `after.png → 200 + PNG magic`)
  }

  summary('Phase I · I-Eval-4', c)
  exitFromCounters('Phase I · I-Eval-4', c)
}

main().catch(async err => {
  console.error('I-Eval-4 threw:', err)
  await teardown()
  process.exit(1)
})
