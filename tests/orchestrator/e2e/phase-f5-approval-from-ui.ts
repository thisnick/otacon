/**
 * Phase F · F5 — Approval-from-UI.
 *
 * A run requiring approval (omit --auto-approve so the bash tool's mutating
 * commands hit the file-backed approval gate). Drive Approve via the
 * deployed VPS's POST /api/v1/escalations/:token/resolve and verify:
 *   - The run sees an `escalation_requested` event
 *   - POSTing approve resolves it; run reaches agent_end
 *   - The session's events.jsonl has a corresponding `escalation_resolved`
 *     event with decision=approve
 * Then test Reject in a separate run.
 *
 * Two flavors (matches task #10 "Click Approve → resumes. Click Reject →
 * blocks."):
 *   F5a — approve flow → run completes
 *   F5b — reject flow → bash returns synthetic-error, agent recovers and
 *         eventually completes (but the rejected tool call's result reflects
 *         the rejection)
 *
 * NOTE on UI-vs-API:
 * Task #10 says "Approval-from-UI ... Click Approve → resumes." The literal
 * UI click requires the React app to render the approval card AND POST the
 * resolve, both of which need the same-origin proxy contract to work.
 * As of pi-spike c8295f9 + bddccc1 the React app fetches the API directly
 * via `window.__API_BASE__` (CORS-blocked when run through `orchestrator ui`)
 * — so a real Playwright click would just fail at "fetch the approval state"
 * before ever reaching the resolve POST. This scenario therefore drives the
 * resolve via direct API POST against the deployed VPS, which is the same
 * effective contract the UI is supposed to exercise. If F3/F4's UI bug
 * lands a fix later, this scenario can be rewritten to drive via Playwright
 * UI clicks.
 *
 * Hardware: phone-4 + XHS canonical (so the bash tool actually has a
 * mutating command to gate on). Single-resource lock — must run after F8.
 *
 * Run:
 *   pnpm test:e2e:phase-f:f5
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

const F5_PROMPT_APPROVE =
  process.env.OTACON_F5_APPROVE_PROMPT ??
  'open Xiaohongshu and tap the home tab once. Then exit.'

const F5_PROMPT_REJECT =
  process.env.OTACON_F5_REJECT_PROMPT ??
  'open Xiaohongshu and tap the home tab once. Then exit.'

interface EscRequested {
  token: string
  prompt: string
  details?: unknown
}

async function resolveEscalation(
  token: string,
  decision: 'approve' | 'reject',
  message: string,
): Promise<{ status: number; raw: string }> {
  const res = await fetch(
    `${VPS_API_BASE}/api/v1/escalations/${encodeURIComponent(token)}/resolve`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, message }),
    },
  )
  return { status: res.status, raw: await res.text() }
}

/**
 * Run a session interactively: start the SSE stream, watch for
 * escalation_requested events, fire `resolveCallback` for each token,
 * keep consuming until terminal.
 *
 * Returns { sessionId, events, terminal, doneSentinel } same as
 * postRunAndConsume but with the resolve loop embedded.
 */
async function runWithApprovalLoop(
  body: {
    workspace: string
    team: string
    phone: string
    userMessage: string
    resume?: 'last' | 'new' | string
    autoReject?: boolean
  },
  resolveCallback: (token: string, payload: EscRequested) => Promise<'approve' | 'reject' | 'skip'>,
  timeoutMs: number,
): Promise<{
  sessionId: string | null
  resolves: Array<{ token: string; decision: string }>
  events: Array<Record<string, unknown>>
  terminal: Record<string, unknown> | null
  doneSentinel: boolean
  httpStatus: number
}> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  const res = await fetch(`${VPS_API_BASE}/api/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  })
  const sessionId = res.headers.get('x-orchestrator-session-id')
  if (!res.ok || !res.body) {
    clearTimeout(t)
    return { sessionId, resolves: [], events: [], terminal: null, doneSentinel: false, httpStatus: res.status }
  }
  const events: Array<Record<string, unknown>> = []
  let terminal: Record<string, unknown> | null = null
  let doneSentinel = false
  const resolves: Array<{ token: string; decision: string }> = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const data = chunk.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n')
        if (data === '[DONE]') { doneSentinel = true; break }
        try {
          const p = JSON.parse(data) as Record<string, unknown>
          events.push(p)
          if (p['kind'] === 'escalation_requested') {
            const token = String(p['token'] ?? '')
            const payload = p['payload'] as EscRequested | undefined
            info(`escalation_requested: token=${token}`)
            const decision = await resolveCallback(token, payload as EscRequested)
            if (decision !== 'skip') {
              const r = await resolveEscalation(token, decision, `auto: ${decision}`)
              info(`POST resolve ${token} ${decision} → ${r.status}`)
              resolves.push({ token, decision })
            }
          }
          if (p['kind'] === 'pi') {
            const inner = p['event'] as Record<string, unknown> | undefined
            if (inner?.['type'] === 'agent_end' || inner?.['type'] === 'agent_error') terminal = p
          }
        } catch {}
      }
      if (doneSentinel) break
    }
  } finally {
    clearTimeout(t)
    try { reader.releaseLock() } catch {}
  }
  return { sessionId, resolves, events, terminal, doneSentinel, httpStatus: res.status }
}

async function fetchEvents(sid: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(
    `${VPS_API_BASE}/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions/${sid}/events`,
    { headers: { accept: 'application/x-ndjson' } },
  )
  if (!res.ok) return []
  const text = await res.text()
  return text
    .split('\n')
    .filter(l => l.length > 0)
    .map(l => {
      try { return JSON.parse(l) as Record<string, unknown> } catch { return {} }
    })
}

async function main(): Promise<void> {
  const c = makeCounters()
  console.log(`\n=== Phase F · F5: Approval-from-(U)I via VPS API ===`)
  console.log(`vps API = ${VPS_API_BASE}`)

  const phoneUrl = await resolvePhoneBaseUrlPhaseF()
  info(`phone base URL = ${phoneUrl}`)

  // -----------------------------------------------------------------------
  section('F5a — Approve flow')
  // -----------------------------------------------------------------------
  const a = await runWithApprovalLoop(
    {
      workspace: ACCOUNT_ID,
      team: TEAM_NAME,
      phone: phoneUrl,
      userMessage: F5_PROMPT_APPROVE,
      resume: 'new',
    },
    async (_token, _payload) => 'approve',
    20 * 60_000,
  )
  info(`F5a session = ${a.sessionId}`)
  info(`F5a resolves issued = ${a.resolves.length}`)
  info(`F5a terminal = ${a.terminal ? 'yes' : 'no'}; done = ${a.doneSentinel}`)
  assert(c, a.httpStatus === 200, `F5a POST /runs → 200 (got ${a.httpStatus})`)
  assert(c, a.sessionId !== null, `F5a session id present`)
  assert(c, a.resolves.length >= 1, `F5a issued ≥1 approve (got ${a.resolves.length})`)
  assert(c, a.terminal !== null, `F5a reached terminal pi event`)
  if (a.terminal) {
    const inner = a.terminal['event'] as Record<string, unknown> | undefined
    assert(c, inner?.['type'] === 'agent_end', `F5a terminal type = agent_end (got ${String(inner?.['type'])})`)
  }
  if (a.sessionId) {
    const persisted = await fetchEvents(a.sessionId)
    const resolvedEvents = persisted.filter(e => e['kind'] === 'escalation_resolved')
    info(`F5a persisted escalation_resolved events: ${resolvedEvents.length}`)
    assert(c, resolvedEvents.length >= 1, `F5a events.jsonl has ≥1 escalation_resolved`)
    const decisions = resolvedEvents.map(e => String(e['decision']))
    assert(c, decisions.every(d => d === 'approve'), `F5a all resolved decisions = approve (got ${decisions.join(',')})`)
  }

  // -----------------------------------------------------------------------
  section('F5b — Reject flow')
  // -----------------------------------------------------------------------
  // Reject every approval. Per the orchestrator's contract, a rejected
  // mutating command returns a synthetic error result to the agent; the
  // agent typically gives up and the run still terminates (agent_end), but
  // with NO phone_action persisted (or with an error-marked one).
  const b = await runWithApprovalLoop(
    {
      workspace: ACCOUNT_ID,
      team: TEAM_NAME,
      phone: phoneUrl,
      userMessage: F5_PROMPT_REJECT,
      resume: 'new',
    },
    async (_token, _payload) => 'reject',
    20 * 60_000,
  )
  info(`F5b session = ${b.sessionId}`)
  info(`F5b resolves issued = ${b.resolves.length}`)
  info(`F5b terminal = ${b.terminal ? 'yes' : 'no'}; done = ${b.doneSentinel}`)
  assert(c, b.httpStatus === 200, `F5b POST /runs → 200 (got ${b.httpStatus})`)
  assert(c, b.resolves.length >= 1, `F5b issued ≥1 reject`)
  assert(c, b.terminal !== null, `F5b reached terminal pi event (after rejection-then-recovery)`)
  if (b.sessionId) {
    const persisted = await fetchEvents(b.sessionId)
    const resolvedEvents = persisted.filter(e => e['kind'] === 'escalation_resolved')
    assert(c, resolvedEvents.length >= 1, `F5b events.jsonl has ≥1 escalation_resolved`)
    const decisions = resolvedEvents.map(e => String(e['decision']))
    assert(c, decisions.every(d => d === 'reject'), `F5b all resolved decisions = reject (got ${decisions.join(',')})`)
  }

  summary('Phase F · F5', c)
  exitFromCounters('Phase F · F5', c)
}

main().catch(err => {
  console.error('F5 threw:', err)
  process.exit(1)
})
