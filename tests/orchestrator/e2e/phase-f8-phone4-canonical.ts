/**
 * Phase F · F8 — Phone-4 + XHS canonical run.
 *
 * Drives the canonical "open xhs and scroll the home feed once, then exit"
 * prompt against the deployed VPS via POST /api/v1/runs, consumes the SSE
 * stream until terminal, and verifies the strict P5 false-pass guards:
 *
 *   - turnCount > 0
 *   - finalText non-empty
 *   - status = "completed"
 *   - At least one phone_action with all 3 screenshot URLs serving 200
 *   - sha256(annotated.png) ≠ sha256(before.png) for at least one mutating
 *     action (proves sharp drew an overlay; folds in the F8/F7 sharp check)
 *   - No sharp-related error lines in `docker logs otacon-orchestrator`
 *
 * Hardware: phone-4 + XHS canonical. Single-resource lock — must NOT run
 * in parallel with F2/F3/F5/F6 (or any other phone-touching scenario).
 *
 * Long-running (~3-8 min for the agent loop). Expects ORCHESTRATOR_API_URL
 * to be set or defaults to https://otacon-orchestrator.tail0437b8.ts.net.
 *
 * Run:
 *   pnpm test:e2e:phase-f:f8
 */
import {
  ACCOUNT_ID,
  ACCOUNT_ID_ENC,
  TEAM_NAME,
  VPS_API_BASE,
  api,
  countTurns,
  extractFinalText,
  extractPhoneActions,
  fetchBytes,
  postRunAndConsume,
  resolvePhoneBaseUrlPhaseF,
  sha256Bytes,
  ssh,
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

const F8_PROMPT =
  process.env.OTACON_F8_PROMPT ??
  'open Xiaohongshu (com.xingin.xhs) and scroll the home feed once, then exit. Tell me what you saw in one sentence.'
const F8_TIMEOUT_MS = Number(process.env.OTACON_F8_TIMEOUT_MS ?? 25 * 60_000)

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function looksLikePng(b: Uint8Array): boolean {
  if (b.length < 8) return false
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_MAGIC[i]) return false
  return true
}

async function main(): Promise<void> {
  const c = makeCounters()
  console.log(`\n=== Phase F · F8: Phone-4 + XHS canonical against ${VPS_API_BASE} ===`)
  console.log(`prompt = ${F8_PROMPT}`)

  section('1. Resolve phone-4 base URL')
  const phoneUrl = await resolvePhoneBaseUrlPhaseF()
  info(`phone base URL = ${phoneUrl}`)

  section('2. POST /api/v1/runs (auto-approve) and consume until terminal')
  const t0 = Date.now()
  const run = await postRunAndConsume(
    {
      workspace: ACCOUNT_ID,
      team: TEAM_NAME,
      phone: phoneUrl,
      userMessage: F8_PROMPT,
      resume: 'new',
      autoApprove: true,
    },
    { timeoutMs: F8_TIMEOUT_MS },
  )
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  info(`elapsed: ${elapsed}s; events=${run.events.length}; sid=${run.sessionId}`)

  assert(c, run.httpStatus === 200, `POST /runs → 200 (got ${run.httpStatus})`)
  assert(c, run.sessionId !== null && run.sessionId.length === 26, `session id present`)
  assert(c, run.terminal !== null, `terminal pi event observed`)
  if (run.terminal) {
    const inner = run.terminal.payload?.['event'] as Record<string, unknown> | undefined
    assert(c, inner?.['type'] === 'agent_end', `terminal type = agent_end (got ${String(inner?.['type'])})`)
  }
  assert(c, run.doneSentinel, `[DONE] sentinel observed`)

  // P5 false-pass guards.
  const turnCount = countTurns(run.events)
  const finalText = extractFinalText(run.events)
  info(`turnCount = ${turnCount}`)
  info(`finalText length = ${finalText.length} chars`)
  if (finalText.length > 0) info(`finalText preview: ${finalText.slice(0, 200)}${finalText.length > 200 ? '…' : ''}`)
  assert(c, turnCount > 0, `turnCount > 0 (got ${turnCount}) — P5 false-pass guard`)
  assert(c, finalText.length > 0, `finalText non-empty (length ${finalText.length}) — P5 false-pass guard`)

  section('3. session.json status = completed')
  if (run.sessionId) {
    const meta = await api<{ status?: string; endedAt?: number }>(
      `/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions/${run.sessionId}`,
    )
    assert(c, meta.status === 200, `GET session → 200`)
    const m = meta.body as { status?: string; endedAt?: number }
    assert(c, m.status === 'completed', `session.status = "completed" (got "${m.status}")`)
    assert(c, typeof m.endedAt === 'number' && m.endedAt > 0, `endedAt > 0`)
  }

  section('4. ≥1 phone_action with 3 screenshots serving 200')
  const actions = extractPhoneActions(run.events)
  info(`phone_actions in stream: ${actions.length}`)
  assert(c, actions.length >= 1, `≥1 phone_action observed (got ${actions.length})`)

  // Pick the first phone_action with all 3 screenshots populated.
  let primary: typeof actions[0] | null = null
  for (const a of actions) {
    if (a.screenshots.before && a.screenshots.annotated && a.screenshots.after) {
      primary = a
      break
    }
  }
  if (!primary) {
    assert(c, false, `no phone_action has all 3 screenshot paths (before+annotated+after)`)
  } else {
    info(`primary phone_action: tcid=${primary.toolCallId} subcommand=${primary.subcommand}`)
    const beforeUrl = traceUrl(ACCOUNT_ID, TEAM_NAME, run.sessionId!, primary.toolCallId, 'before.png')
    const annotatedUrl = traceUrl(ACCOUNT_ID, TEAM_NAME, run.sessionId!, primary.toolCallId, 'annotated.png')
    const afterUrl = traceUrl(ACCOUNT_ID, TEAM_NAME, run.sessionId!, primary.toolCallId, 'after.png')

    const before = await fetchBytes(beforeUrl)
    const annotated = await fetchBytes(annotatedUrl)
    const after = await fetchBytes(afterUrl)

    assert(c, before.status === 200, `before.png → 200 (got ${before.status})`)
    assert(c, annotated.status === 200, `annotated.png → 200 (got ${annotated.status})`)
    assert(c, after.status === 200, `after.png → 200 (got ${after.status})`)

    assert(c, looksLikePng(before.bytes), `before.png magic bytes (${before.bytes.length} bytes)`)
    assert(c, looksLikePng(annotated.bytes), `annotated.png magic bytes (${annotated.bytes.length} bytes)`)
    assert(c, looksLikePng(after.bytes), `after.png magic bytes (${after.bytes.length} bytes)`)

    // Sharp-actually-ran check: annotated bytes differ from before bytes.
    const beforeSha = sha256Bytes(before.bytes)
    const annotatedSha = sha256Bytes(annotated.bytes)
    info(`sha256(before)    = ${beforeSha}`)
    info(`sha256(annotated) = ${annotatedSha}`)
    assert(c, beforeSha !== annotatedSha, `annotated.png bytes differ from before.png (sharp drew overlay)`)
  }

  section('5. SSH check — no sharp errors in docker logs (Phase E flagged item)')
  const r = ssh(`sudo -n docker logs otacon-orchestrator 2>&1 | grep -i sharp || echo NO_MATCHES`)
  const matched = r.stdout.split('\n').filter(l => l.length > 0 && l !== 'NO_MATCHES')
  info(`docker logs grep -i sharp matched ${matched.length} lines`)
  for (const l of matched.slice(0, 6)) info(`  ${l}`)
  const errorLines = matched.filter(l => /error|cannot|failed|missing/i.test(l))
  assert(c, errorLines.length === 0, `zero sharp-related error lines in docker logs (${errorLines.length} found)`)

  summary('Phase F · F8', c)
  exitFromCounters('Phase F · F8', c)
}

main().catch(err => {
  console.error('F8 threw:', err)
  process.exit(1)
})
