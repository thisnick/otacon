/**
 * Pi-spike S8 — Specific session resume via --session.
 *
 * Authoritative test for task #4 scenario S8. Per implementer's locked
 * behavior matrix (task #3 C2):
 *
 *   - `--new` → fresh ULID; last-session.txt UPDATED to fresh id
 *   - default (no flag) → reads last-session.txt; UPDATES it (no-op)
 *   - `--session <id>` → resumes <id>; last-session.txt LEFT ALONE
 *
 * Three-step verification:
 *
 *   1. Default run → creates sid1; last-session.txt → sid1
 *   2. --new run → creates sid2; last-session.txt → sid2
 *   3. --session sid1 run → continues sid1; last-session.txt STILL → sid2
 *
 * Plus byte-snapshot guards:
 *   - After (3): sid2's messages.jsonl + events.jsonl byte length unchanged
 *   - After (3): sid1's messages.jsonl + events.jsonl byte length GREW
 *
 * Plus default-resume sanity: a fourth (default) run after step 3 must
 * resume sid2 (the value of last-session.txt), not sid1.
 *
 * Run:
 *   pnpm test:e2e:orchestrator:s8
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  assert,
  cleanupFixture,
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

async function main(): Promise<void> {
  const c = makeCounters()
  const fix = makeFixture('s8')

  console.log(`\n=== Pi-spike S8: --session specific resume ===`)
  console.log(`dataDir = ${fix.dataDir}`)

  try {
    section('0. Seed')
    const seed = seedSpike(fix)
    assert(c, seed.status === 0, `seed exits 0`)

    let phoneUrl = ''
    try { phoneUrl = await resolvePhoneBaseUrl() } catch (e) {
      info(`resolvePhone failed: ${(e as Error).message}`)
    }

    section('1. First run (default — creates sid1)')
    const r1 = runOtaconRun(fix, {
      message: 'remember the marker WORD-ALPHA-1. exit.',
      phone: phoneUrl || undefined,
      autoApprove: true,
    })
    assert(c, r1.status === 0, `r1 exits 0`)
    const sid1 = readLastSessionId(fix) ?? ''
    assert(c, sid1 !== '', `last-session.txt = sid1 after r1 (got "${sid1}")`)

    section('2. Second run (--new → creates sid2; last-session.txt → sid2)')
    const r2 = runOtaconRun(fix, {
      message: 'remember the marker WORD-BETA-2. exit.',
      resume: 'new',
      phone: phoneUrl || undefined,
      autoApprove: true,
    })
    assert(c, r2.status === 0, `r2 exits 0`)
    const sid2 = readLastSessionId(fix) ?? ''
    assert(c, sid2 !== '' && sid2 !== sid1,
      `last-session.txt = sid2 after r2 (got ${sid2}, sid1 was ${sid1})`)

    const sids = listSessionIds(fix)
    assert(c, sids.length === 2 && sids.includes(sid1) && sids.includes(sid2),
      `sessions/ has both sid1 and sid2 (got ${sids.join(', ')})`)

    // Snapshot byte lengths of both sessions' files.
    const msgFile1 = path.join(sessionDirOf(fix, sid1), 'messages.jsonl')
    const evFile1 = path.join(sessionDirOf(fix, sid1), 'events.jsonl')
    const msgFile2 = path.join(sessionDirOf(fix, sid2), 'messages.jsonl')
    const evFile2 = path.join(sessionDirOf(fix, sid2), 'events.jsonl')
    const msgBytes1Before = fs.statSync(msgFile1).size
    const evBytes1Before = fs.statSync(evFile1).size
    const msgBytes2Before = fs.statSync(msgFile2).size
    const evBytes2Before = fs.statSync(evFile2).size
    info(`pre-r3: sid1.msg=${msgBytes1Before}B sid1.ev=${evBytes1Before}B sid2.msg=${msgBytes2Before}B sid2.ev=${evBytes2Before}B`)

    section('3. Third run (--session sid1 → resumes sid1; last-session.txt LEFT ALONE = sid2)')
    const r3 = runOtaconRun(fix, {
      message: 'what marker did you remember earlier in THIS session? exit.',
      resume: { sessionId: sid1 },
      phone: phoneUrl || undefined,
      autoApprove: true,
    })
    assert(c, r3.status === 0, `r3 exits 0`)

    const lastAfterR3 = readLastSessionId(fix)
    assert(c, lastAfterR3 === sid2,
      `last-session.txt unchanged after --session (still sid2; got ${lastAfterR3})`)

    // sid1's files grew (resumed). sid2's files unchanged.
    const msgBytes1After = fs.statSync(msgFile1).size
    const evBytes1After = fs.statSync(evFile1).size
    const msgBytes2After = fs.statSync(msgFile2).size
    const evBytes2After = fs.statSync(evFile2).size
    info(`post-r3: sid1.msg=${msgBytes1After}B sid1.ev=${evBytes1After}B sid2.msg=${msgBytes2After}B sid2.ev=${evBytes2After}B`)

    assert(c, msgBytes1After > msgBytes1Before,
      `sid1 messages.jsonl GREW after --session sid1 (${msgBytes1Before} → ${msgBytes1After})`)
    assert(c, evBytes1After > evBytes1Before,
      `sid1 events.jsonl GREW after --session sid1 (${evBytes1Before} → ${evBytes1After})`)
    assert(c, msgBytes2After === msgBytes2Before,
      `sid2 messages.jsonl unchanged after --session sid1 (${msgBytes2Before} → ${msgBytes2After})`)
    assert(c, evBytes2After === evBytes2Before,
      `sid2 events.jsonl unchanged after --session sid1 (${evBytes2Before} → ${evBytes2After})`)

    // r3 should mention WORD-ALPHA-1 (since it resumed sid1's context),
    // NOT WORD-BETA-2.
    assert(c, r3.stdout.includes('WORD-ALPHA-1'),
      `r3 stdout contains WORD-ALPHA-1 (proves resumed sid1's context)`)

    section('4. Fourth run (default) must resume sid2, not sid1')
    const r4 = runOtaconRun(fix, {
      message: 'and what marker did you remember in THIS session? exit.',
      phone: phoneUrl || undefined,
      autoApprove: true,
    })
    assert(c, r4.status === 0, `r4 exits 0`)
    // Expect the agent to recall WORD-BETA-2 (sid2's marker), since
    // last-session.txt was sid2 going in.
    assert(c, r4.stdout.includes('WORD-BETA-2'),
      `r4 stdout contains WORD-BETA-2 (default-resume picked up sid2, not sid1)`)
  } finally {
    cleanupFixture(fix)
  }

  summary('S8', c)
  exitFromCounters('S8', c)
}

main().catch(err => {
  console.error('S8 runner threw:', err)
  process.exit(1)
})
