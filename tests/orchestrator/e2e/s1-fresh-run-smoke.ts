/**
 * Pi-spike S1 — Fresh run smoke.
 *
 * Authoritative test for task #4 scenario S1.
 *
 * Verifies that a first-ever `otacon run` against a freshly-seeded
 * `.otacon-test-data/` against `xhs:test` workspace + `social-media-engagement`
 * team produces:
 *
 *   - Exit code 0
 *   - Console markers in stdout (per the implementer's printer dialect):
 *       `▶ run`, `[user]`, `[assistant]`, `┌ <tool>$`, `└ ok`, `■ done`
 *     (NOTE: implementer's printer emits `└ ok` / `└ error`, not `└ exit 0`.)
 *   - .otacon-test-data/workspaces/xhs:test/teams/social-media-engagement/sessions/{id}/
 *     created with: messages.jsonl, events.jsonl, session.json, sandbox/{env,memory,traces}/
 *   - sandbox/env, sandbox/memory, sandbox/traces are symlinks
 *   - last-session.txt at teams/social-media-engagement/last-session.txt matches the session id
 *   - events.jsonl contains the required event kinds:
 *       system_set, user_message, pi.agent_end, plus at least one pi.message_*
 *   - session.json: status='completed', endedAt > 0
 *   - messages.jsonl line count >= 1 (at least one assistant message)
 *
 * Prompt is memory-only ("list files in memory/") — exercises bash + read,
 * doesn't require XHS for S1, but we still pass --phone so the lead prompt's
 * `otacon-alloc provision` doesn't 500. Phone resolved via the orchestrator's
 * resolvePhone.
 *
 * Run:
 *   pnpm test:e2e:orchestrator:s1
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  ACCOUNT_ID,
  TEAM_NAME,
  assert,
  cleanupFixture,
  exitFromCounters,
  info,
  listSessionIds,
  makeCounters,
  makeFixture,
  readJsonlEvents,
  readLastSessionId,
  resolvePhoneBaseUrl,
  runOtaconRun,
  section,
  seedSpike,
  sessionDirOf,
  summary,
} from './helpers/spike.js'

const PROMPT =
  process.env.OTACON_SPIKE_S1_PROMPT ??
  'list files in memory and tell me what you see'

async function main(): Promise<void> {
  const c = makeCounters()
  const fix = makeFixture('s1')

  console.log(`\n=== Pi-spike S1: fresh run smoke ===`)
  console.log(`dataDir = ${fix.dataDir}`)
  console.log(`workspace = ${ACCOUNT_ID}`)
  console.log(`team      = ${TEAM_NAME}`)
  console.log(`prompt    = ${PROMPT}`)

  try {
    section('0. Seed (.otacon-test-data/ workspace + team + S2 marker)')
    const seed = seedSpike(fix)
    assert(c, seed.status === 0, `seed exits 0 (got ${seed.status})`)
    if (seed.status !== 0) info(`seed stderr: ${seed.stderr.slice(0, 800)}`)

    section('1. Resolve phone-4 → host base URL via registry')
    let phoneUrl = ''
    try {
      phoneUrl = await resolvePhoneBaseUrl()
      info(`phone base URL = ${phoneUrl}`)
    } catch (e) {
      assert(c, false, `resolvePhone(phone-4) succeeded — ${(e as Error).message}`)
    }

    section('2. Run otacon CLI (fresh, first-ever for this team)')
    const res = runOtaconRun(fix, {
      message: PROMPT,
      phone: phoneUrl || undefined,
      autoApprove: true,
    })
    assert(c, res.status === 0, `otacon run exits 0 (got ${res.status})`)
    if (res.status !== 0) {
      info(`stderr (first 1500 chars): ${res.stderr.slice(0, 1500)}`)
      info(`stdout (last 1000 chars):  ${res.stdout.slice(-1000)}`)
    }

    section('3. Console marker assertions')
    for (const marker of ['▶ run', '[user]', '[assistant]', '┌ ', '└ ', '■ done']) {
      assert(c, res.stdout.includes(marker), `stdout contains "${marker}"`)
    }

    section('4. Session dir + filesystem assertions')
    const sids = listSessionIds(fix)
    assert(c, sids.length === 1, `exactly one session created (got ${sids.length})`)
    const sid = sids[0] ?? ''
    if (!sid) {
      summary('S1', c)
      exitFromCounters('S1', c)
    }
    const sdir = sessionDirOf(fix, sid)

    assert(c, fs.existsSync(path.join(sdir, 'messages.jsonl')), 'messages.jsonl exists')
    assert(c, fs.existsSync(path.join(sdir, 'events.jsonl')), 'events.jsonl exists')
    assert(c, fs.existsSync(path.join(sdir, 'session.json')), 'session.json exists')

    const sandbox = path.join(sdir, 'sandbox')
    assert(c, fs.existsSync(sandbox), 'sandbox/ dir exists')
    for (const link of ['env', 'memory', 'traces']) {
      const lp = path.join(sandbox, link)
      assert(c, fs.existsSync(lp), `sandbox/${link} exists`)
      try {
        assert(c, fs.lstatSync(lp).isSymbolicLink(), `sandbox/${link} is a symlink`)
      } catch {
        assert(c, false, `sandbox/${link} is a symlink (lstat failed)`)
      }
    }

    section('5. last-session.txt assertions')
    const lastSid = readLastSessionId(fix)
    assert(c, lastSid === sid, `last-session.txt matches session id (got ${lastSid})`)

    section('6. session.json content (status=completed, endedAt>0)')
    let sessionJson: Record<string, unknown> = {}
    try {
      sessionJson = JSON.parse(fs.readFileSync(path.join(sdir, 'session.json'), 'utf-8'))
    } catch (e) {
      assert(c, false, `session.json parses (${(e as Error).message})`)
    }
    assert(c, sessionJson.status === 'completed',
      `session.status === 'completed' (got ${String(sessionJson.status)})`)
    assert(c, typeof sessionJson.endedAt === 'number' && Number(sessionJson.endedAt) > 0,
      `session.endedAt is non-zero number (got ${String(sessionJson.endedAt)})`)

    section('7. messages.jsonl content (Phase 5 false-pass — verify real work)')
    const msgFile = path.join(sdir, 'messages.jsonl')
    const msgEntries = readJsonlEvents(msgFile)
    assert(c, msgEntries.length >= 1, `messages.jsonl has ≥1 entries (got ${msgEntries.length})`)
    const assistantMsgs = msgEntries.filter(m => m.role === 'assistant')
    assert(c, assistantMsgs.length >= 1, `messages.jsonl contains at least one assistant message`)
    // Phase 5 lesson: a "completed" run with stopReason='error' or empty
    // content array is a false-pass. Make sure SOME assistant message has
    // non-empty text content AND no error stopReason.
    const hasRealAssistantContent = assistantMsgs.some(m => {
      const content = m.content as Array<{ type?: string; text?: string }> | undefined
      const hasText = Array.isArray(content) && content.some(
        c => c.type === 'text' && typeof c.text === 'string' && c.text.length > 0,
      )
      const hasToolCall = Array.isArray(content) && content.some(
        c => c.type === 'toolCall',
      )
      const stopReason = m.stopReason as string | undefined
      const noError = stopReason !== 'error'
      return (hasText || hasToolCall) && noError
    })
    assert(c, hasRealAssistantContent,
      `messages.jsonl has at least one assistant message with non-empty text/toolCall AND stopReason !== 'error' (Phase 5 false-pass guard)`)
    if (!hasRealAssistantContent) {
      const stopReasons = assistantMsgs.map(m => m.stopReason).filter(Boolean)
      const errorMessages = assistantMsgs.map(m => m.errorMessage).filter(Boolean)
      info(`assistant stopReasons: ${JSON.stringify(stopReasons)}`)
      info(`assistant errorMessages: ${JSON.stringify(errorMessages)}`)
    }

    section('8. events.jsonl content (kinds present)')
    const events = readJsonlEvents(path.join(sdir, 'events.jsonl'))
    assert(c, events.length >= 3, `events.jsonl has ≥3 events (got ${events.length})`)
    const kinds = new Set(
      events.map(e => {
        if (e.kind === 'pi') {
          const piEvent = e.event as { type?: string } | undefined
          return `pi.${piEvent?.type ?? 'unknown'}`
        }
        return String(e.kind)
      }),
    )
    info(`event kinds observed: ${[...kinds].join(', ')}`)
    assert(c, kinds.has('system_set'), `events.jsonl contains system_set`)
    assert(c, kinds.has('user_message'), `events.jsonl contains user_message`)
    assert(c, kinds.has('pi.agent_end'), `events.jsonl contains pi.agent_end`)
    const hasMessageEnd = [...kinds].some(k => k.startsWith('pi.message_'))
    assert(c, hasMessageEnd, `events.jsonl contains at least one pi.message_* event`)
  } finally {
    cleanupFixture(fix)
  }

  summary('S1', c)
  exitFromCounters('S1', c)
}

main().catch(err => {
  console.error('S1 runner threw:', err)
  process.exit(1)
})
