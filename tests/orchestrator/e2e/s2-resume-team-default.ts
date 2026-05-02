/**
 * Pi-spike S2 — Resume by team default.
 *
 * Authoritative test for task #4 scenario S2.
 *
 * Pre-condition: seed (idempotent) populates `memory/sessions.log` with the
 * `INIT_SENTINEL_aXY7` marker (per task #3 C2). First run reads the marker
 * file. Second run (no flag — default = continue last session) verifies:
 *
 *   - Same session id continues (NOT a new one)
 *   - sessions/ dir still has exactly ONE session subdir
 *   - messages.jsonl APPENDED (line count + byte length grow)
 *   - events.jsonl APPENDED similarly
 *   - last-session.txt unchanged (same id)
 *   - Agent's response on the second run demonstrates awareness of prior
 *     conversation: stdout contains the `INIT_SENTINEL_aXY7` token.
 *
 * Run:
 *   pnpm test:e2e:orchestrator:s2
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  assert,
  cleanupFixture,
  countLines,
  exitFromCounters,
  info,
  listSessionIds,
  makeCounters,
  makeFixture,
  readLastSessionId,
  resolvePhoneBaseUrl,
  runOtaconRun,
  section,
  seedSpike,
  sessionDirOf,
  summary,
} from './helpers/spike.js'

const PROMPT_FIRST =
  process.env.OTACON_SPIKE_S1_PROMPT ??
  'read memory/sessions.log and tell me exactly what marker you see'
const PROMPT_RESUME =
  process.env.OTACON_SPIKE_S2_PROMPT ??
  'in this same session, what marker did you just read? repeat it back exactly.'

async function main(): Promise<void> {
  const c = makeCounters()
  const fix = makeFixture('s2')

  console.log(`\n=== Pi-spike S2: resume by team default ===`)
  console.log(`dataDir = ${fix.dataDir}`)

  try {
    section('0. Seed')
    const seed = seedSpike(fix)
    assert(c, seed.status === 0, `seed exits 0 (got ${seed.status})`)

    let phoneUrl = ''
    try { phoneUrl = await resolvePhoneBaseUrl() } catch (e) { info(`resolvePhone failed: ${(e as Error).message}`) }

    section('1. First run (establishes a session)')
    const r1 = runOtaconRun(fix, {
      message: PROMPT_FIRST,
      phone: phoneUrl || undefined,
      autoApprove: true,
    })
    assert(c, r1.status === 0, `first run exits 0 (got ${r1.status})`)
    if (r1.status !== 0) info(`r1 stderr: ${r1.stderr.slice(0, 1000)}`)

    const sids1 = listSessionIds(fix)
    assert(c, sids1.length === 1, `1st run: exactly one session created (got ${sids1.length})`)
    const sid = sids1[0] ?? ''
    if (!sid) {
      summary('S2', c)
      exitFromCounters('S2', c)
    }
    const sdir = sessionDirOf(fix, sid)
    const msgFile = path.join(sdir, 'messages.jsonl')
    const evFile = path.join(sdir, 'events.jsonl')
    const msgBytes1 = fs.statSync(msgFile).size
    const evBytes1 = fs.statSync(evFile).size
    const msgLines1 = countLines(msgFile)
    const evLines1 = countLines(evFile)
    info(`after r1: messages=${msgLines1} lines / ${msgBytes1}B; events=${evLines1} lines / ${evBytes1}B`)
    assert(c, readLastSessionId(fix) === sid, `after r1: last-session.txt = sid`)

    // Phase 5 false-pass: ensure first run actually had real assistant work.
    let firstRunOk = false
    try {
      const lines = fs.readFileSync(msgFile, 'utf-8').split('\n').filter(Boolean)
      const last = JSON.parse(lines[lines.length - 1])
      firstRunOk = last.role === 'assistant' && last.stopReason !== 'error'
    } catch { /* fall through */ }
    assert(c, firstRunOk,
      `first run's last assistant message has stopReason !== 'error' (Phase 5 false-pass guard)`)

    section('2. Second run — default resume (no --new, no --session)')
    const r2 = runOtaconRun(fix, {
      message: PROMPT_RESUME,
      phone: phoneUrl || undefined,
      autoApprove: true,
    })
    assert(c, r2.status === 0, `second run exits 0 (got ${r2.status})`)
    if (r2.status !== 0) info(`r2 stderr: ${r2.stderr.slice(0, 1000)}`)

    section('3. Resume assertions')
    const sids2 = listSessionIds(fix)
    assert(c, sids2.length === 1, `still exactly one session (got ${sids2.length})`)
    assert(c, sids2[0] === sid, `session id unchanged (got ${sids2[0]} vs ${sid})`)
    assert(c, readLastSessionId(fix) === sid, `last-session.txt still = sid`)

    const msgBytes2 = fs.statSync(msgFile).size
    const evBytes2 = fs.statSync(evFile).size
    const msgLines2 = countLines(msgFile)
    const evLines2 = countLines(evFile)
    info(`after r2: messages=${msgLines2} lines / ${msgBytes2}B; events=${evLines2} lines / ${evBytes2}B`)
    assert(c, msgBytes2 > msgBytes1, `messages.jsonl byte length grew (${msgBytes1} → ${msgBytes2})`)
    assert(c, evBytes2 > evBytes1, `events.jsonl byte length grew (${evBytes1} → ${evBytes2})`)
    assert(c, msgLines2 > msgLines1, `messages.jsonl line count grew (${msgLines1} → ${msgLines2})`)
    assert(c, evLines2 > evLines1, `events.jsonl line count grew (${evLines1} → ${evLines2})`)

    // S2 marker — agent must echo INIT_SENTINEL_aXY7 from prior context.
    assert(c, r2.stdout.includes('INIT_SENTINEL_aXY7'),
      `r2 stdout contains INIT_SENTINEL_aXY7 (proves resume-context-awareness)`)
  } finally {
    cleanupFixture(fix)
  }

  summary('S2', c)
  exitFromCounters('S2', c)
}

main().catch(err => {
  console.error('S2 runner threw:', err)
  process.exit(1)
})
