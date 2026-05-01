/**
 * Pi-spike S7 — Resume preserves Pi format (round-trip).
 *
 * Authoritative test for task #4 scenario S7. The two-file persistence model
 * (messages.jsonl = Pi format, events.jsonl = our format) only works if
 * messages.jsonl can be loaded and passed back to `agent.continue(messages)`
 * without parse error. This scenario verifies that round-trip via the
 * implementer's chosen entry point (likely a small node script that imports
 * `@mariozechner/pi-agent-core`'s `Agent` and calls `.continue()` with the
 * loaded messages).
 *
 * No phone hardware required — this is pure file-format validation.
 *
 * Pre-condition: a session with a populated messages.jsonl. Could be the
 * first run of this scenario (cheap, no mutating actions) or a session left
 * over from S1.
 *
 * STATUS: SKELETON — assertions stubbed pending implementer (#3) handoff.
 *
 * The implementer ships a verification script. Two likely shapes:
 *   (a) A `pnpm otacon resume-check --workspace ... --team ... --session ...`
 *       subcommand that loads messages.jsonl, calls `agent.continue([...])`
 *       with a no-op prompt, and reports parse success/failure.
 *   (b) A standalone `tsx scripts/resume-check.ts <session-dir>` script.
 *
 * Either way, this scenario invokes whichever the implementer surfaces.
 *
 * Run:
 *   pnpm test:e2e:spike-pi:s7
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
  const fix = makeFixture('s7')

  console.log(`\n=== Pi-spike S7: resume preserves Pi format (round-trip) ===`)
  console.log(`dataDir = ${fix.dataDir}`)

  try {
    section('0. Bootstrap')
    bootstrapTODO(fix)

    section('1. Run otacon once to populate a messages.jsonl')
    // TODO[#4-S7]: run a cheap prompt (e.g. "list files in memory") that
    // exercises the agent loop without touching the phone. Capture sid +
    // messages.jsonl path.
    info(`(stub) populating-run pending implementer handoff`)

    section('2. Round-trip via implementer-shipped resume-check script')
    // TODO[#4-S7]: invoke the implementer's verification entry. Two
    // candidate shapes — try whichever they ship:
    //
    //   const res = runOtacon(
    //     ['resume-check', '--workspace', ACCOUNT_ID, '--team', TEAM_NAME, '--session', sid],
    //     fix.dataDir,
    //   )
    //
    // OR
    //
    //   const res = spawnSync('pnpm', [
    //     'tsx', 'scripts/resume-check.ts', path.join(fix.teamStateDir, 'sessions', sid),
    //   ], { cwd: REPO_ROOT, encoding: 'utf-8' })
    //
    //   assert(c, res.status === 0, 'resume-check exits 0')
    //   assert(c, !/parse error|invalid message|JSON\.parse/i.test(res.stderr),
    //     'no parse-error / invalid-message stderr')
    //   assert(c, /round-trip ok|messages: \d+|continued/i.test(res.stdout),
    //     'round-trip success marker present in stdout')
    //
    // If implementer surfaces a different shape (e.g. expects a flag set, or
    // exposes via a JS API only), file observed-vs-expected.
    info(`(stub) round-trip assertions pending implementer handoff`)
  } finally {
    cleanupFixture(fix)
  }

  summary('S7', c)
  skeletonExit('S7', c)
}

main().catch(err => {
  console.error('S7 runner threw:', err)
  process.exit(1)
})
