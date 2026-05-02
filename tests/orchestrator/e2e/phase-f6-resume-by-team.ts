/**
 * Phase F · F6 — Resume-by-team.
 *
 * Verifies the canonical "team continues across runs" flow against the
 * deployed VPS:
 *
 *   1. Start a run with resume='new' (force fresh session). Wait for
 *      completion. Note the session id S1.
 *   2. Inspect events for S1 — verify the persisted events.jsonl roundtrips
 *      cleanly (UI's session-detail replay path).
 *   3. Start a SECOND run with resume='last' (default). Verify the new
 *      session id == S1 (the prior session is being continued, NOT a new one).
 *   4. Verify both runs' messages are visible in the same session's
 *      messages.jsonl (line count grew).
 *
 * Memory-only prompts (no phone touch needed for this assertion). Doesn't
 * tie up phone-4 even though the resolver still runs.
 *
 * Note on UI mention in task #10:
 *   Task #10 says "Fire a run via UI, complete, click into SessionDetail
 *   from RunsList, replay events correctly. Then start a NEW run with
 *   same workspace+team, no `--new` flag — confirm continues prior session
 *   (last-session.txt)." The "via UI" part is blocked on the F3/F4 web-app
 *   CORS bug; once that's fixed, we can rewrite this to drive via Playwright.
 *   The "continues prior session" semantic is server-side and verifiable
 *   directly via API — that's what this scenario checks.
 *
 * Run:
 *   pnpm test:e2e:phase-f:f6
 */
import {
  ACCOUNT_ID,
  ACCOUNT_ID_ENC,
  TEAM_NAME,
  VPS_API_BASE,
  postRunAndConsume,
  resolvePhoneBaseUrlPhaseF,
} from './helpers/phase-f.js'
import {
  assert,
  exitFromCounters,
  info,
  makeCounters,
  section,
  summary,
} from './helpers/spike.js'

const F6_PROMPT_1 =
  process.env.OTACON_F6_PROMPT_1 ?? 'list files in memory/ — return one short sentence.'
const F6_PROMPT_2 =
  process.env.OTACON_F6_PROMPT_2 ?? 'remind me what files you saw last time, in one sentence.'

async function main(): Promise<void> {
  const c = makeCounters()
  console.log(`\n=== Phase F · F6: Resume-by-team ===`)
  console.log(`vps API = ${VPS_API_BASE}`)

  const phoneUrl = await resolvePhoneBaseUrlPhaseF()
  info(`phone base URL = ${phoneUrl}`)

  // -----------------------------------------------------------------------
  section('1. First run with resume=new — establishes a session')
  // -----------------------------------------------------------------------
  const r1 = await postRunAndConsume(
    {
      workspace: ACCOUNT_ID,
      team: TEAM_NAME,
      phone: phoneUrl,
      userMessage: F6_PROMPT_1,
      resume: 'new',
      autoApprove: true,
    },
    { timeoutMs: 12 * 60_000 },
  )
  assert(c, r1.httpStatus === 200, `r1 POST /runs → 200`)
  assert(c, r1.sessionId !== null && r1.sessionId.length === 26, `r1 session id present`)
  assert(c, r1.terminal !== null, `r1 reached terminal pi event`)
  assert(c, r1.doneSentinel, `r1 [DONE] sentinel observed`)
  const sid = r1.sessionId!
  info(`r1 session = ${sid}`)

  // Event replay sanity — fetch events.jsonl and confirm it roundtrips.
  const r1Events = await fetch(
    `${VPS_API_BASE}/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions/${sid}/events`,
    { headers: { accept: 'application/x-ndjson' } },
  )
  assert(c, r1Events.status === 200, `GET .../events → 200`)
  const r1EventsText = await r1Events.text()
  const r1EventLines = r1EventsText.split('\n').filter(l => l.length > 0)
  assert(c, r1EventLines.length > 5, `r1 events.jsonl has >5 lines (got ${r1EventLines.length})`)
  // Every line should JSON-parse.
  let r1Bad = 0
  for (const l of r1EventLines) { try { JSON.parse(l) } catch { r1Bad++ } }
  assert(c, r1Bad === 0, `every event line JSON-parses (${r1Bad} bad)`)

  // Messages count after r1.
  const r1Msgs = await fetch(
    `${VPS_API_BASE}/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions/${sid}/messages`,
  )
  const r1MsgsText = await r1Msgs.text()
  const r1MsgsCount = r1MsgsText.split('\n').filter(l => l.length > 0).length
  info(`r1 messages.jsonl line count = ${r1MsgsCount}`)
  assert(c, r1MsgsCount >= 2, `r1 messages.jsonl has ≥2 lines (user + assistant)`)

  // -----------------------------------------------------------------------
  section('2. Second run with resume=last — must continue prior session')
  // -----------------------------------------------------------------------
  const r2 = await postRunAndConsume(
    {
      workspace: ACCOUNT_ID,
      team: TEAM_NAME,
      phone: phoneUrl,
      userMessage: F6_PROMPT_2,
      resume: 'last',
      autoApprove: true,
    },
    { timeoutMs: 12 * 60_000 },
  )
  assert(c, r2.httpStatus === 200, `r2 POST /runs → 200`)
  assert(c, r2.sessionId === sid, `r2 session id == r1 session id (resumed prior; got ${r2.sessionId} vs ${sid})`)
  assert(c, r2.terminal !== null, `r2 reached terminal pi event`)

  // -----------------------------------------------------------------------
  section('3. After both runs — messages.jsonl line count grew')
  // -----------------------------------------------------------------------
  const r2Msgs = await fetch(
    `${VPS_API_BASE}/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions/${sid}/messages`,
  )
  const r2MsgsText = await r2Msgs.text()
  const r2MsgsCount = r2MsgsText.split('\n').filter(l => l.length > 0).length
  info(`after r2, messages.jsonl line count = ${r2MsgsCount}`)
  assert(c, r2MsgsCount > r1MsgsCount, `messages.jsonl grew: ${r1MsgsCount} → ${r2MsgsCount}`)

  // Events file also grew.
  const r2Events = await fetch(
    `${VPS_API_BASE}/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions/${sid}/events`,
    { headers: { accept: 'application/x-ndjson' } },
  )
  const r2EventsText = await r2Events.text()
  const r2EventLines = r2EventsText.split('\n').filter(l => l.length > 0).length
  info(`after r2, events.jsonl line count = ${r2EventLines}`)
  assert(c, r2EventLines > r1EventLines.length, `events.jsonl grew: ${r1EventLines.length} → ${r2EventLines}`)

  summary('Phase F · F6', c)
  exitFromCounters('Phase F · F6', c)
}

main().catch(err => {
  console.error('F6 threw:', err)
  process.exit(1)
})
