/**
 * Phase F · F1 — API smoke against deployed VPS.
 *
 * Folds in the original F2 ("CLI run/sessions list parity") because the
 * orchestrator CLI's `run` and `sessions list` are filesystem-only by design
 * (per docs/orchestrator-v2-plan.md load-bearing decision: remote control is
 * browser-only via `ui --api`, no CLI-streaming-to-remote). What F2 was
 * really exercising — "can an external client kick off a run on the deployed
 * VPS and get a result" — is the API contract this scenario verifies.
 *
 * Verified surface:
 *
 *   1. Endpoint coverage from the API spec:
 *        GET /healthz
 *        GET /api/v1/workspaces                 → 200 + xhs:test seeded
 *        GET /api/v1/workspaces/:ws/teams       → 200 + social-media-engagement
 *        GET /api/v1/workspaces/:ws/teams/:team/sessions       → 200 array
 *        GET /api/v1/workspaces/:ws/teams/:team/sessions/:bogus → 404
 *        GET /api/v1/workspaces/:ws/teams/:team/sessions/:bogus/messages → 404
 *
 *   2. Error envelope shape `{error: {code, message, details?}}` for ≥3 cases:
 *        - workspace_not_found
 *        - team_not_found
 *        - session_not_found
 *        - bad_request (POST /runs with missing body)
 *        - escalation_not_found (POST /escalations/<bogus>/resolve)
 *        - bad_request (invalid decision value)
 *
 *   3. Driving a full agent run via POST /api/v1/runs against the deployed
 *      VPS (this is the "F2 fold-in" — same client semantics as a CLI POST).
 *      Light prompt that doesn't touch the phone (memory-only "list memory"
 *      style) so this scenario can run independent of phone-4 availability
 *      and stays parallel-safe with the hardware-touching scenarios.
 *
 * Phone-4 IS resolved (because the lead workflow's `otacon-alloc provision`
 * step requires a phone or it 500s — see s1-fresh-run-smoke.ts header), but
 * the prompt deliberately doesn't TAP/SWIPE/etc. so the scenario stays light.
 *
 * Run:
 *   ORCHESTRATOR_API_URL=https://otacon-orchestrator.tail0437b8.ts.net \
 *     pnpm test:e2e:phase-f:f1
 */
import {
  ACCOUNT_ID,
  ACCOUNT_ID_ENC,
  TEAM_NAME,
  VPS_API_BASE,
  api,
  countTurns,
  extractFinalText,
  extractInnerEventTypes,
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

const F1_PROMPT =
  process.env.OTACON_F1_PROMPT ??
  'list the files in memory/ and tell me what you see in one short sentence.'

async function main(): Promise<void> {
  const c = makeCounters()
  console.log(`\n=== Phase F · F1: API smoke against ${VPS_API_BASE} ===`)
  console.log(`workspace = ${ACCOUNT_ID}`)
  console.log(`team      = ${TEAM_NAME}`)
  console.log(`prompt    = ${F1_PROMPT}`)

  // -----------------------------------------------------------------------
  section('1. Health + workspace/team enumeration (success paths)')
  // -----------------------------------------------------------------------

  const health = await api<{ ok: boolean }>('/healthz')
  assert(c, health.status === 200, `GET /healthz → 200 (got ${health.status})`)
  assert(c, (health.body as { ok?: boolean })?.ok === true, `/healthz body has ok:true`)

  const ws = await api<Array<{ id: string; kind: string }>>('/api/v1/workspaces')
  assert(c, ws.status === 200, `GET /api/v1/workspaces → 200 (got ${ws.status})`)
  assert(
    c,
    Array.isArray(ws.body) && ws.body.some(w => w.id === ACCOUNT_ID),
    `workspaces list contains seeded "${ACCOUNT_ID}"`,
  )

  const teams = await api<Array<{ name: string; expectedWorkspaceKind: string }>>(
    `/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams`,
  )
  assert(c, teams.status === 200, `GET .../teams → 200 (got ${teams.status})`)
  assert(
    c,
    Array.isArray(teams.body) && teams.body.some(t => t.name === TEAM_NAME),
    `teams list contains seeded "${TEAM_NAME}"`,
  )

  const sessionsBefore = await api<Array<{ id: string }>>(
    `/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions`,
  )
  assert(c, sessionsBefore.status === 200, `GET .../sessions → 200 (got ${sessionsBefore.status})`)
  assert(c, Array.isArray(sessionsBefore.body), `sessions response is an array`)
  const sessionsBeforeIds = (sessionsBefore.body as Array<{ id: string }>).map(s => s.id)
  info(`existing sessions before run: ${sessionsBeforeIds.length}`)

  // -----------------------------------------------------------------------
  section('2. Error envelope shape for 4xx responses')
  // -----------------------------------------------------------------------

  const isErrorEnvelope = (
    body: unknown,
    expectedCode: string,
  ): { ok: boolean; reason?: string } => {
    if (typeof body !== 'object' || body === null) return { ok: false, reason: 'not an object' }
    const err = (body as { error?: unknown }).error
    if (typeof err !== 'object' || err === null) return { ok: false, reason: 'no error key' }
    const e = err as Record<string, unknown>
    if (typeof e['code'] !== 'string') return { ok: false, reason: 'code not string' }
    if (typeof e['message'] !== 'string') return { ok: false, reason: 'message not string' }
    if (e['code'] !== expectedCode) return { ok: false, reason: `code=${String(e['code'])} expected ${expectedCode}` }
    return { ok: true }
  }

  // 2a. workspace_not_found (404)
  const bogusWs = await api<unknown>(`/api/v1/workspaces/nope%3Athere/teams`)
  assert(c, bogusWs.status === 404, `GET teams of bogus workspace → 404 (got ${bogusWs.status})`)
  {
    const r = isErrorEnvelope(bogusWs.body, 'workspace_not_found')
    assert(c, r.ok, `bogus-workspace error envelope shape ok (${r.reason ?? 'ok'})`)
  }

  // 2b. team_not_found (404)
  const bogusTeam = await api<unknown>(`/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/nope-team/sessions`)
  assert(c, bogusTeam.status === 404, `GET sessions of bogus team → 404 (got ${bogusTeam.status})`)
  {
    const r = isErrorEnvelope(bogusTeam.body, 'team_not_found')
    assert(c, r.ok, `bogus-team error envelope shape ok (${r.reason ?? 'ok'})`)
  }

  // 2c. session_not_found (404) on session metadata
  const BOGUS_SID = '01HBOGUS000000000000000000'
  const bogusSession = await api<unknown>(
    `/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions/${BOGUS_SID}`,
  )
  assert(c, bogusSession.status === 404, `GET bogus session → 404 (got ${bogusSession.status})`)
  {
    const r = isErrorEnvelope(bogusSession.body, 'session_not_found')
    assert(c, r.ok, `bogus-session error envelope shape ok (${r.reason ?? 'ok'})`)
  }

  // 2d. session_not_found on messages
  const bogusMsgs = await api<unknown>(
    `/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions/${BOGUS_SID}/messages`,
  )
  assert(c, bogusMsgs.status === 404, `GET messages of bogus session → 404 (got ${bogusMsgs.status})`)
  {
    const r = isErrorEnvelope(bogusMsgs.body, 'session_not_found')
    assert(c, r.ok, `bogus-session-messages error envelope shape ok (${r.reason ?? 'ok'})`)
  }

  // 2e. escalation_not_found (404)
  const bogusEsc = await api<unknown>(
    `/api/v1/escalations/${encodeURIComponent('notatoken:nothing')}/resolve`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    },
  )
  assert(c, bogusEsc.status === 404, `POST resolve bogus escalation → 404 (got ${bogusEsc.status})`)
  {
    const r = isErrorEnvelope(bogusEsc.body, 'escalation_not_found')
    assert(c, r.ok, `bogus-escalation error envelope shape ok (${r.reason ?? 'ok'})`)
  }

  // 2f. bad_request — missing body field on POST /runs
  const badRun = await api<unknown>(`/api/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert(c, badRun.status === 400, `POST /runs missing body → 400 (got ${badRun.status})`)
  {
    const r = isErrorEnvelope(badRun.body, 'bad_request')
    assert(c, r.ok, `bad-request error envelope shape ok (${r.reason ?? 'ok'})`)
  }

  // 2g. bad_request — invalid decision value on resolve
  const badDecision = await api<unknown>(
    `/api/v1/escalations/${encodeURIComponent('whatever:thing')}/resolve`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'banana' }),
    },
  )
  assert(c, badDecision.status === 400, `POST resolve bad decision → 400 (got ${badDecision.status})`)
  {
    const r = isErrorEnvelope(badDecision.body, 'bad_request')
    assert(c, r.ok, `bad-decision error envelope shape ok (${r.reason ?? 'ok'})`)
  }

  // -----------------------------------------------------------------------
  section('3. POST /api/v1/runs — drive a full agent run via SSE (was F2)')
  // -----------------------------------------------------------------------

  // Resolve phone-4 base URL for the lead workflow's allocator (memory-only
  // prompt won't touch the phone but provision needs to succeed).
  let phoneUrl = ''
  try {
    phoneUrl = await resolvePhoneBaseUrlPhaseF()
    info(`phone base URL = ${phoneUrl}`)
  } catch (e) {
    assert(c, false, `resolvePhone(phone-4) succeeded — ${(e as Error).message}`)
  }

  const t0 = Date.now()
  const run = await postRunAndConsume(
    {
      workspace: ACCOUNT_ID,
      team: TEAM_NAME,
      phone: phoneUrl,
      userMessage: F1_PROMPT,
      resume: 'new',
      autoApprove: true,
    },
    { timeoutMs: 12 * 60_000, verbose: false },
  )
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  info(`run elapsed: ${elapsed}s`)
  info(`events received: ${run.events.length}`)
  info(`session id: ${run.sessionId ?? '(none in header)'}`)
  info(`terminal kind: ${run.terminal?.payload ? JSON.stringify((run.terminal.payload['event'] as Record<string, unknown> | undefined)?.['type']) : 'none'}`)
  info(`[DONE] sentinel: ${run.doneSentinel}`)

  assert(c, run.httpStatus === 200, `POST /runs → 200 (got ${run.httpStatus})`)
  assert(c, typeof run.sessionId === 'string' && run.sessionId.length === 26, `x-orchestrator-session-id header is a 26-char ULID (got ${String(run.sessionId)})`)
  assert(c, run.events.length > 0, `received >0 SSE events (got ${run.events.length})`)
  assert(c, run.doneSentinel, `terminal [DONE] sentinel observed`)
  assert(c, run.terminal !== null, `terminal pi event observed (agent_end or agent_error)`)
  if (run.terminal?.payload) {
    const inner = run.terminal.payload['event'] as Record<string, unknown> | undefined
    assert(c, inner?.['type'] === 'agent_end', `terminal pi event type is agent_end (got ${String(inner?.['type'])})`)
  }

  // P5 false-pass guards.
  const turnCount = countTurns(run.events)
  const finalText = extractFinalText(run.events)
  info(`turnCount = ${turnCount}`)
  info(`finalText length = ${finalText.length} chars`)
  if (finalText.length > 0) info(`finalText preview: ${finalText.slice(0, 160)}${finalText.length > 160 ? '…' : ''}`)
  assert(c, turnCount > 0, `turnCount > 0 (got ${turnCount}) — P5 false-pass guard`)
  assert(c, finalText.length > 0, `finalText non-empty (length ${finalText.length}) — P5 false-pass guard`)

  // Verify expected outer + inner chunk types appeared.
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
  // Outer expected: agent_start/end, turn_start/end, message_start/update/end,
  // tool_execution_start/end. Verify the load-bearing ones.
  assert(c, outerChunkTypes.has('agent_start'), `outer agent_start present`)
  assert(c, outerChunkTypes.has('agent_end'), `outer agent_end present`)
  assert(c, outerChunkTypes.has('turn_start'), `outer turn_start present`)
  assert(c, outerChunkTypes.has('turn_end'), `outer turn_end present`)
  assert(c, outerChunkTypes.has('message_update'), `outer message_update present`)
  assert(c, outerChunkTypes.has('tool_execution_start'), `outer tool_execution_start present (bash was called)`)
  // Inner: pi-agent-core's text streaming uses text_start/text_delta/text_end.
  // These are the v7-equivalent text-streaming chunks; their absence would
  // mean NO text was streamed (the P5 false-pass shape).
  assert(c, innerChunkTypes.has('text_delta') || innerChunkTypes.has('text_start'),
    `inner text streaming present (text_start or text_delta) — got [${Array.from(innerChunkTypes).join(', ')}]`)

  // -----------------------------------------------------------------------
  section('4. Session is now visible via the read endpoints')
  // -----------------------------------------------------------------------

  if (run.sessionId) {
    const sessionsAfter = await api<Array<{ id: string; status: string }>>(
      `/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions`,
    )
    assert(c, sessionsAfter.status === 200, `GET sessions after run → 200`)
    const idsAfter = (sessionsAfter.body as Array<{ id: string; status: string }>).map(s => s.id)
    assert(c, idsAfter.includes(run.sessionId), `session ${run.sessionId} appears in sessions list`)

    const sessionMeta = await api<{ id: string; status: string; endedAt: number | null }>(
      `/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions/${run.sessionId}`,
    )
    assert(c, sessionMeta.status === 200, `GET session metadata → 200`)
    const meta = sessionMeta.body as { id?: string; status?: string; endedAt?: number | null }
    assert(c, meta.status === 'completed', `session status = "completed" (got "${meta.status}")`)
    assert(c, typeof meta.endedAt === 'number' && meta.endedAt > 0, `session endedAt > 0 (got ${String(meta.endedAt)})`)

    // Messages endpoint is reachable.
    const msgs = await fetch(
      `${VPS_API_BASE}/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions/${run.sessionId}/messages`,
    )
    assert(c, msgs.status === 200, `GET .../messages → 200 (got ${msgs.status})`)
    const ct = msgs.headers.get('content-type') ?? ''
    assert(c, ct.includes('x-ndjson'), `messages content-type is x-ndjson (got ${ct})`)
    const text = await msgs.text()
    const lines = text.split('\n').filter(l => l.length > 0)
    assert(c, lines.length >= 1, `messages.jsonl has ≥1 line (got ${lines.length})`)
  }

  summary('Phase F · F1', c)
  exitFromCounters('Phase F · F1', c)
}

main().catch(err => {
  console.error('F1 threw:', err)
  process.exit(1)
})
