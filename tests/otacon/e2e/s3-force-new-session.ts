/**
 * Pi-spike S3 — Force new session via --new.
 *
 * Authoritative test for task #4 scenario S3. Verifies that `--new` overrides
 * the resume-by-default behavior: a fresh session id is allocated, a new
 * sessions/{id}/ dir is created, last-session.txt is updated to point at the
 * new id, and the OLD session's files are unchanged.
 *
 * Pre-condition: S1 has run (or an equivalent first pass populates the data
 * dir). Then re-run with `--new` and assert:
 *   - New session id (different from the original)
 *   - sessions/ dir now has TWO session subdirs
 *   - last-session.txt updated to the new id
 *   - Old session's messages.jsonl + events.jsonl are byte-identical to the
 *     pre-second-run snapshot (proves --new doesn't accidentally append to
 *     the old session)
 *
 * Hardware: phone-4 + XHS canonical.
 *
 * STATUS: SKELETON — assertions stubbed pending implementer (#3) handoff.
 *
 * Run:
 *   pnpm test:e2e:spike-pi:s3
 */
import {
  bootstrapTODO,
  cleanupFixture,
  info,
  makeCounters,
  makeFixture,
  section,
  skeletonExit,
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
    section('0. Bootstrap')
    bootstrapTODO(fix)

    section('1. First run (establishes a session)')
    // TODO[#4-S3]: as in S2 — run otacon with PROMPT_FIRST. Record sid1.
    // Snapshot byte-length of messages.jsonl + events.jsonl.
    info(`(stub) first-run pending implementer handoff`)

    section('2. Second run with --new (forces fresh session)')
    // TODO[#4-S3]: run otacon with --new + PROMPT_NEW. Assert:
    //   - exit 0
    //   - sessions/ dir now has 2 entries (sid1 + sid2 != sid1)
    //   - last-session.txt updated to sid2
    //   - sessions/{sid1}/messages.jsonl byte length unchanged from snapshot
    //   - sessions/{sid1}/events.jsonl byte length unchanged from snapshot
    //   - sessions/{sid2}/messages.jsonl exists with ≥3 lines
    //   - sessions/{sid2}/events.jsonl exists with ≥3 lines
    info(`(stub) --new behavior assertions pending implementer handoff`)
  } finally {
    cleanupFixture(fix)
  }

  summary('S3', c)
  skeletonExit('S3', c)
}

main().catch(err => {
  console.error('S3 runner threw:', err)
  process.exit(1)
})
