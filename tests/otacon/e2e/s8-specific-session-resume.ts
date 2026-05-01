/**
 * Pi-spike S8 — Specific session resume via --session.
 *
 * Authoritative test for task #4 scenario S8. After running TWO sessions
 * (call them sid1 and sid2; sid2 is most recent, last-session.txt points to
 * it), use `--session sid1` to continue the OLDER session. Assert:
 *
 *   - The run continues sid1 (NOT sid2 = the most recent).
 *   - sessions/{sid1}/messages.jsonl is appended to.
 *   - sessions/{sid2}/messages.jsonl is byte-unchanged from snapshot.
 *   - last-session.txt behavior — implementer to confirm at handoff:
 *       * Option A: `--session sid1` updates last-session.txt to sid1
 *         (so subsequent default-resume targets sid1).
 *       * Option B: `--session sid1` does NOT update last-session.txt (it
 *         remains sid2, treating --session as a one-shot override).
 *       Confirm with implementer at handoff which is the chosen behavior;
 *       file observed-vs-expected if neither A nor B matches.
 *
 * Hardware: phone-4 + XHS canonical (the agent run is what triggers the
 * resume; the prompt itself doesn't have to mutate).
 *
 * STATUS: SKELETON — assertions stubbed pending implementer (#3) handoff.
 *
 * Run:
 *   pnpm test:e2e:spike-pi:s8
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

async function main(): Promise<void> {
  const c = makeCounters()
  const fix = makeFixture('s8')

  console.log(`\n=== Pi-spike S8: specific session resume via --session ===`)
  console.log(`dataDir = ${fix.dataDir}`)

  try {
    section('0. Bootstrap')
    bootstrapTODO(fix)

    section('1. First run (creates sid1)')
    // TODO[#4-S8]: run with a marker prompt; record sid1.
    info(`(stub) first-run pending implementer handoff`)

    section('2. Second run with --new (creates sid2; last-session.txt = sid2)')
    // TODO[#4-S8]: run with --new; record sid2; snapshot byte-lengths of
    // both sessions' messages.jsonl + events.jsonl.
    info(`(stub) second --new run pending implementer handoff`)

    section('3. Third run with --session sid1 (continues older)')
    // TODO[#4-S8]: run with --session sid1, then assert:
    //   - sessions/{sid1}/messages.jsonl byte-length grew (appended)
    //   - sessions/{sid2}/messages.jsonl byte-length unchanged from snapshot
    //   - sessions/{sid1}/events.jsonl appended
    //   - sessions/{sid2}/events.jsonl unchanged
    //   - last-session.txt now contains sid1 OR sid2 — record which, then
    //     check against implementer's confirmed behavior. We assert ONE of:
    //       option A: lastSessionAfter === sid1
    //       option B: lastSessionAfter === sid2
    //     and FAIL if neither matches. The implementer confirms which is
    //     correct at handoff.
    info(`(stub) --session resume assertions pending implementer handoff`)
  } finally {
    cleanupFixture(fix)
  }

  summary('S8', c)
  skeletonExit('S8', c)
}

main().catch(err => {
  console.error('S8 runner threw:', err)
  process.exit(1)
})
