/**
 * Pi-spike S4 — Approval gate (TTY prompt).
 *
 * Authoritative test for task #4 scenario S4. Drives a mutating bash command
 * (`otacon tap` against phone-4) that triggers the `beforeToolCall` approval
 * hook, verifies the TTY prompt shape, and exercises both the approve (`y`)
 * and reject (`n`) decision paths.
 *
 * APPROVE path (y):
 *   - Prompt of the form `Approve: otacon tap ...? [y/n]` appears on stdout
 *   - Type `y\n` → command executes
 *   - events.jsonl contains a `phone_action` event for the tap
 *   - traces/{tcid}/ has before/annotated/after PNGs
 *
 * REJECT path (n):
 *   - Same prompt
 *   - Type `n\n` → command blocked
 *   - Pi delivers a synthetic-error tool-result back to the model with the
 *     gate's reason text
 *   - Run continues (does NOT crash) — model adapts and either retries
 *     differently or wraps up
 *   - events.jsonl contains the rejection audit (kind tbd by implementer —
 *     likely `escalation_resolved` with decision='reject', or a custom
 *     `approval_rejected` event)
 *
 * Hardware: phone-4 + XHS canonical. The mutating bash invocation requires
 * the phone to be online and reachable through the registry.
 *
 * STATUS: SKELETON — assertions stubbed pending implementer (#3) handoff.
 *
 * Caveat — TTY vs piped stdin: Pi's approval gate may use readline backed by
 * `process.stdin`. If readline rejects piped (non-TTY) stdin, the test must
 * use `node-pty` to spawn a real PTY. Implementer to confirm at handoff;
 * otherwise we file observed-vs-expected.
 *
 * Run:
 *   pnpm test:e2e:spike-pi:s4
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

const PROMPT_MUTATE =
  process.env.OTACON_SPIKE_S4_PROMPT ??
  'open Xiaohongshu and tap the home tab'

async function main(): Promise<void> {
  const c = makeCounters()
  const fix = makeFixture('s4')

  console.log(`\n=== Pi-spike S4: approval gate (TTY prompt) ===`)
  console.log(`dataDir = ${fix.dataDir}`)
  console.log(`prompt  = ${PROMPT_MUTATE}`)

  try {
    section('0. Bootstrap')
    bootstrapTODO(fix)

    section('1. APPROVE path — type "y", expect command executes')
    // TODO[#4-S4-approve]:
    //   const proc = runOtaconInteractive(
    //     ['run', '--workspace', ACCOUNT_ID, '--team', TEAM_NAME, '--new', PROMPT_MUTATE],
    //     fix.dataDir,
    //   )
    //   let stdout = ''
    //   proc.stdout!.on('data', chunk => {
    //     const s = chunk.toString('utf-8')
    //     stdout += s
    //     if (/Approve:.*\?\s*\[y\/n\]/i.test(s)) {
    //       proc.stdin!.write('y\n')
    //     }
    //   })
    //   const exitCode = await new Promise<number>(res => proc.on('exit', code => res(code ?? 1)))
    //
    //   assert(c, exitCode === 0, `approve-path otacon run exits 0 (got ${exitCode})`)
    //   assert(c, /Approve:.*\?\s*\[y\/n\]/i.test(stdout), 'approval prompt appeared in stdout')
    //
    //   const sid = fs.readFileSync(path.join(fix.teamStateDir, 'last-session.txt'), 'utf-8').trim()
    //   const events = readLines(path.join(fix.teamStateDir, 'sessions', sid, 'events.jsonl'))
    //                    .map(l => JSON.parse(l))
    //   const phoneActions = events.filter(e => e.kind === 'phone_action')
    //   assert(c, phoneActions.length >= 1, `events.jsonl has at least one phone_action (got ${phoneActions.length})`)
    //   const pa = phoneActions[0]
    //   assert(c, pa.screenshots?.before && pa.screenshots?.annotated && pa.screenshots?.after,
    //     'phone_action event carries before/annotated/after paths')
    info(`(stub) approve-path assertions pending implementer handoff`)

    section('2. REJECT path — type "n", expect command blocked + run continues')
    // TODO[#4-S4-reject]: same as above but write 'n\n', then assert:
    //   - exit 0 (the run still completes, just without the mutating action)
    //   - stdout contains the prompt
    //   - events.jsonl contains a rejection-audit event of the implementer's
    //     chosen kind (escalation_resolved with decision='reject', or
    //     approval_rejected). Confirm exact kind at handoff.
    //   - events.jsonl does NOT contain a successful phone_action for the
    //     blocked call (i.e. tool-result should be a synthetic error, not
    //     a real exit)
    //   - The agent's subsequent text demonstrates it saw the rejection
    //     (mentions "permission denied" / "user rejected" or similar — fuzzy
    //     check; implementer to confirm exact text contract at handoff).
    info(`(stub) reject-path assertions pending implementer handoff`)
  } finally {
    cleanupFixture(fix)
  }

  summary('S4', c)
  skeletonExit('S4', c)
}

main().catch(err => {
  console.error('S4 runner threw:', err)
  process.exit(1)
})
