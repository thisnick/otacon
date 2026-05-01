/**
 * Pi-spike S5 — Phone action artifacts.
 *
 * Authoritative test for task #4 scenario S5. After a phone-action through
 * the bash tool's `otacon` mutating subcommand, verifies the screenshots are
 * written to disk as valid PNGs and the events.jsonl entry's screenshot
 * paths match the on-disk files.
 *
 * Pre-condition: a session that ran an approved mutating action (S4 approve
 * path, or an inline replay here). Then assert:
 *   - `traces/{tool_call_id}/before.png` exists and is a valid PNG
 *   - `traces/{tool_call_id}/annotated.png` exists and is a valid PNG
 *   - `traces/{tool_call_id}/after.png` exists and is a valid PNG
 *   - `annotated.png` differs from `before.png` (perceptual hash diff ≥ N
 *     bits — same threshold phase2 uses, ≥5 bits)
 *   - events.jsonl `phone_action` event's `screenshots.{before,annotated,after}`
 *     paths resolve to the existing files (relative to .otacon-data/ or
 *     session dir per implementer's chosen convention — confirm at handoff)
 *
 * Hardware: phone-4 + XHS canonical.
 *
 * STATUS: SKELETON — assertions stubbed pending implementer (#3) handoff.
 *
 * Run:
 *   pnpm test:e2e:spike-pi:s5
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
  const fix = makeFixture('s5')

  console.log(`\n=== Pi-spike S5: phone action artifacts ===`)
  console.log(`dataDir = ${fix.dataDir}`)

  try {
    section('0. Bootstrap')
    bootstrapTODO(fix)

    section('1. Run otacon with a mutating prompt + auto-approve')
    // TODO[#4-S5]: run with auto-approve (env or flag — confirm with
    // implementer; spike scope is TTY-only per #3, so we use the same
    // interactive `y\n` injection from S4).
    info(`(stub) approve-path run pending implementer handoff`)

    section('2. Walk events.jsonl for phone_action entries')
    // TODO[#4-S5]: load events.jsonl, find phone_action entries:
    //   const events = readLines(path.join(sdir, 'events.jsonl')).map(l => JSON.parse(l))
    //   const actions = events.filter(e => e.kind === 'phone_action')
    //   assert(c, actions.length >= 1, `events.jsonl has ≥1 phone_action (got ${actions.length})`)
    //   for (const a of actions) {
    //     for (const which of ['before', 'annotated', 'after'] as const) {
    //       const p = a.screenshots[which]
    //       assert(c, typeof p === 'string' && p.length > 0, `phone_action.screenshots.${which} is non-empty string`)
    //       const abs = path.isAbsolute(p) ? p : path.join(fix.dataDir, p)
    //       // Also try relative-to-session-dir if that's the convention:
    //       const fallback = path.join(sdir, p)
    //       const pathOnDisk = fs.existsSync(abs) ? abs : (fs.existsSync(fallback) ? fallback : null)
    //       assert(c, pathOnDisk !== null, `phone_action.${which} resolves to a real file on disk`)
    //       if (pathOnDisk) {
    //         const meta = await sharp(pathOnDisk).metadata()
    //         assert(c, meta.format === 'png', `${which}.png is a valid PNG (got ${meta.format})`)
    //       }
    //     }
    //     // Visual-diff check: annotated vs before should differ ≥5 bits
    //     // (use png-diff helper — same approach as phase2-xhs-actions.ts):
    //     const diff = await pngDiff(beforePath, annotatedPath)
    //     assert(c, diff.bitDiff >= 5, `annotated differs from before by ≥5 bits (got ${diff.bitDiff})`)
    //   }
    info(`(stub) artifact + visual-diff assertions pending implementer handoff`)
  } finally {
    cleanupFixture(fix)
  }

  summary('S5', c)
  skeletonExit('S5', c)
}

main().catch(err => {
  console.error('S5 runner threw:', err)
  process.exit(1)
})
