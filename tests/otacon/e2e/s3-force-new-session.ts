/**
 * Pi-spike S3 — Force new session via --new.
 *
 * Authoritative test for task #4 scenario S3.
 *
 * Pre-condition: a first run has populated `last-session.txt`. Then re-run
 * with `--new` and assert:
 *
 *   - New session id (different from the original)
 *   - sessions/ dir now has TWO session subdirs
 *   - last-session.txt updated to the new id
 *   - Old session's messages.jsonl + events.jsonl are byte-identical to
 *     pre-second-run snapshot (proves --new doesn't append to the old
 *     session)
 *
 * Run:
 *   pnpm test:e2e:spike-pi:s3
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

const PROMPT_FIRST =
  process.env.OTACON_SPIKE_S1_PROMPT ??
  'list files in memory and tell me what you see'
const PROMPT_NEW =
  process.env.OTACON_SPIKE_S3_PROMPT ??
  'fresh start. list memory contents.'

async function main(): Promise<void> {
  const c = makeCounters()
  const fix = makeFixture('s3')

  console.log(`\n=== Pi-spike S3: force new session via --new ===`)
  console.log(`dataDir = ${fix.dataDir}`)

  try {
    section('0. Seed')
    const seed = seedSpike(fix)
    assert(c, seed.status === 0, `seed exits 0 (got ${seed.status})`)

    let phoneUrl = ''
    try { phoneUrl = await resolvePhoneBaseUrl() } catch (e) { info(`resolvePhone failed: ${(e as Error).message}`) }

    section('1. First run (establishes session sid1)')
    const r1 = runOtaconRun(fix, {
      message: PROMPT_FIRST,
      phone: phoneUrl || undefined,
      autoApprove: true,
    })
    assert(c, r1.status === 0, `first run exits 0 (got ${r1.status})`)
    if (r1.status !== 0) info(`r1 stderr: ${r1.stderr.slice(0, 800)}`)

    const sids1 = listSessionIds(fix)
    assert(c, sids1.length === 1, `1st run: exactly one session (got ${sids1.length})`)
    const sid1 = sids1[0] ?? ''
    if (!sid1) {
      summary('S3', c)
      exitFromCounters('S3', c)
    }
    const sdir1 = sessionDirOf(fix, sid1)
    const msgFile1 = path.join(sdir1, 'messages.jsonl')
    const evFile1 = path.join(sdir1, 'events.jsonl')
    const msgBytes1 = fs.statSync(msgFile1).size
    const evBytes1 = fs.statSync(evFile1).size
    const msgHash1 = fs.readFileSync(msgFile1).toString('base64')
    const evHash1 = fs.readFileSync(evFile1).toString('base64')

    section('2. Second run with --new (forces fresh session)')
    const r2 = runOtaconRun(fix, {
      message: PROMPT_NEW,
      resume: 'new',
      phone: phoneUrl || undefined,
      autoApprove: true,
    })
    assert(c, r2.status === 0, `second --new run exits 0 (got ${r2.status})`)
    if (r2.status !== 0) info(`r2 stderr: ${r2.stderr.slice(0, 800)}`)

    section('3. --new behavior assertions')
    const sids2 = listSessionIds(fix)
    assert(c, sids2.length === 2, `--new run: now 2 sessions (got ${sids2.length})`)
    const sid2 = sids2.find(s => s !== sid1) ?? ''
    assert(c, sid2 !== '' && sid2 !== sid1, `sid2 differs from sid1 (sid1=${sid1}, sid2=${sid2})`)

    // last-session.txt UPDATED to sid2.
    const lastAfter2 = readLastSessionId(fix)
    assert(c, lastAfter2 === sid2,
      `after --new: last-session.txt → sid2 (got ${lastAfter2}, want ${sid2})`)

    // Old session: byte-identical (no append).
    const msgBytes1After = fs.statSync(msgFile1).size
    const evBytes1After = fs.statSync(evFile1).size
    const msgHash1After = fs.readFileSync(msgFile1).toString('base64')
    const evHash1After = fs.readFileSync(evFile1).toString('base64')
    assert(c, msgBytes1After === msgBytes1,
      `sid1's messages.jsonl byte length unchanged (${msgBytes1} → ${msgBytes1After})`)
    assert(c, evBytes1After === evBytes1,
      `sid1's events.jsonl byte length unchanged (${evBytes1} → ${evBytes1After})`)
    assert(c, msgHash1After === msgHash1,
      `sid1's messages.jsonl bytes unchanged (sha-equivalent)`)
    assert(c, evHash1After === evHash1,
      `sid1's events.jsonl bytes unchanged`)

    // New session has its own files.
    const sdir2 = sessionDirOf(fix, sid2)
    assert(c, fs.existsSync(path.join(sdir2, 'messages.jsonl')), `sid2/messages.jsonl exists`)
    assert(c, fs.existsSync(path.join(sdir2, 'events.jsonl')), `sid2/events.jsonl exists`)
    assert(c, fs.existsSync(path.join(sdir2, 'session.json')), `sid2/session.json exists`)
  } finally {
    cleanupFixture(fix)
  }

  summary('S3', c)
  exitFromCounters('S3', c)
}

main().catch(err => {
  console.error('S3 runner threw:', err)
  process.exit(1)
})
