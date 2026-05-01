/**
 * Pi-spike S2 — Resume by team default.
 *
 * Authoritative test for task #4 scenario S2. Verifies that re-running
 * `otacon run` on the same workspace + team without `--new` continues the
 * prior session (does NOT spawn a new one).
 *
 * Pre-condition: S1 has run (or this scenario runs an S1-equivalent first
 * pass to populate the data dir). Then re-run with a different prompt and
 * assert:
 *   - Same session id continues (NOT a new one)
 *   - `messages.jsonl` is APPENDED to (line count grows; pre-existing
 *     lines are byte-identical)
 *   - `events.jsonl` is APPENDED to (line count grows)
 *   - Agent's response demonstrates awareness of prior conversation
 *     (mentions specifics from the first run)
 *   - `last-session.txt` unchanged (same id)
 *
 * Hardware: phone-4 + XHS canonical.
 *
 * STATUS: SKELETON — assertions stubbed pending implementer (#3) handoff.
 *
 * Run:
 *   pnpm test:e2e:spike-pi:s2
 */
import {
  ACCOUNT_ID,
  TEAM_NAME,
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
const PROMPT_RESUME =
  process.env.OTACON_SPIKE_S2_PROMPT ??
  'what did you see last time? summarize'

async function main(): Promise<void> {
  const c = makeCounters()
  const fix = makeFixture('s2')

  console.log(`\n=== Pi-spike S2: resume by team default ===`)
  console.log(`dataDir = ${fix.dataDir}`)
  console.log(`prompt1 = ${PROMPT_FIRST}`)
  console.log(`prompt2 = ${PROMPT_RESUME}`)

  try {
    section('0. Bootstrap')
    bootstrapTODO(fix)

    section('1. First run (establishes a session, like S1)')
    // TODO[#4-S2]: run otacon with PROMPT_FIRST, capture the session id from
    // last-session.txt. Snapshot the line counts for messages.jsonl and
    // events.jsonl AND the byte length of each (so we can assert the prior
    // bytes are unchanged after the second run).
    info(`(stub) first-run pending implementer handoff`)

    section('2. Second run (default = continue last session)')
    // TODO[#4-S2]: run otacon with PROMPT_RESUME (NO --new flag). Verify:
    //   - exit 0
    //   - last-session.txt is unchanged (same sid)
    //   - sessions/{sid}/messages.jsonl line count > snapshot AND first N bytes
    //     match snapshot byte-for-byte (proves append, not rewrite)
    //   - sessions/{sid}/events.jsonl appended similarly
    //   - sessions/ dir has only ONE session id (no new dir created)
    //   - agent stdout mentions something specific from PROMPT_FIRST's run
    //     (a memory-file name from the first run, ideally — but at minimum,
    //     a reference indicating it has prior context, not a cold start).
    //     This is the substance assertion that distinguishes "resume worked"
    //     from "new session that reads from memory dir." Keyword check is
    //     inherently fuzzy — implementer to confirm at handoff what unique
    //     marker we can rely on (e.g. echoing back a memory file name).
    info(`(stub) resume assertions pending implementer handoff`)
  } finally {
    cleanupFixture(fix)
  }

  summary('S2', c)
  skeletonExit('S2', c)
}

main().catch(err => {
  console.error('S2 runner threw:', err)
  process.exit(1)
})
