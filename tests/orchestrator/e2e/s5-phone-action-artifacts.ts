/**
 * Pi-spike S5 — Phone action artifacts.
 *
 * Authoritative test for task #4 scenario S5. After an approved mutating
 * `otacon` call, verifies:
 *
 *   - traces/{tool_call_id}/before.png is a valid PNG (sharp metadata)
 *   - traces/{tool_call_id}/annotated.png is a valid PNG
 *   - traces/{tool_call_id}/after.png is a valid PNG
 *   - annotated.png bytes differ from before.png (sha256)
 *   - events.jsonl phone_action.payload.screenshots paths resolve to those
 *     files on disk. Per implementer: paths are relative to
 *     ORCHESTRATOR_DATA_DIR when set absolute, else relative to process.cwd().
 *     The harness sets ORCHESTRATOR_DATA_DIR to an absolute path so paths in
 *     events.jsonl are absolute and stable.
 *
 * Run:
 *   pnpm test:e2e:orchestrator:s5
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
  readJsonlEvents,
  resolvePhoneBaseUrl,
  runOtaconRun,
  section,
  seedSpike,
  sessionDirOf,
  summary,
} from './helpers/spike.js'

// SHA-256 file digest for trace-screenshot validation. pHash is too coarse
// for localized tap-circle / arrow / box overlays (an 8x8 grayscale-mean
// hash quantizes 1080x2340 → 64 pixels, so a 50px ring may not flip a
// single bit). sha256 is the right "did the overlay actually get drawn"
// check — see png-diff.ts comments.
import { sha256File } from './helpers/png-diff.js'
import sharp from 'sharp'

const PROMPT_MUTATE =
  process.env.OTACON_SPIKE_S4_PROMPT ??
  'open Xiaohongshu (com.xingin.xhs) and tap the home tab. then exit.'

interface EventLike {
  kind?: string
  payload?: {
    toolCallId?: string
    screenshots?: { before?: string; annotated?: string; after?: string }
    exitCode?: number
  }
}

async function main(): Promise<void> {
  const c = makeCounters()
  const fix = makeFixture('s5')

  console.log(`\n=== Pi-spike S5: phone action artifacts ===`)
  console.log(`dataDir = ${fix.dataDir}`)

  try {
    section('0. Seed + resolve phone-4')
    const seed = seedSpike(fix)
    assert(c, seed.status === 0, `seed exits 0`)
    let phoneUrl = ''
    try { phoneUrl = await resolvePhoneBaseUrl() } catch (e) {
      info(`resolvePhone failed: ${(e as Error).message}`)
    }
    assert(c, phoneUrl !== '', `phone base URL resolved`)

    section('1. Run with --auto-approve to capture phone_action artifacts')
    const r = runOtaconRun(fix, {
      message: PROMPT_MUTATE,
      resume: 'new',
      phone: phoneUrl,
      autoApprove: true,
    })
    assert(c, r.status === 0, `otacon run exits 0 (got ${r.status})`)
    if (r.status !== 0) info(`stderr (first 1500): ${r.stderr.slice(0, 1500)}`)

    const sids = listSessionIds(fix)
    const sid = sids[sids.length - 1] ?? ''
    assert(c, sid !== '', `session created`)
    if (!sid) {
      summary('S5', c)
      exitFromCounters('S5', c)
    }
    const sdir = sessionDirOf(fix, sid)

    section('2. events.jsonl phone_action assertions')
    const events = readJsonlEvents(path.join(sdir, 'events.jsonl')) as EventLike[]
    const phoneActions = events.filter(e => e.kind === 'phone_action')
    assert(c, phoneActions.length >= 1,
      `events.jsonl has ≥1 phone_action (got ${phoneActions.length})`)

    section('3. Per-action artifact + visual-diff assertions')
    let actionIdx = 0
    for (const a of phoneActions) {
      const tcid = a.payload?.toolCallId ?? `(idx=${actionIdx})`
      const before = a.payload?.screenshots?.before ?? ''
      const annotated = a.payload?.screenshots?.annotated ?? ''
      const after = a.payload?.screenshots?.after ?? ''
      info(`phone_action[${actionIdx}] tcid=${tcid} before=${before.slice(0, 80)}…`)

      // Resolve paths: implementer says set ORCHESTRATOR_DATA_DIR absolute and
      // paths in events are absolute. We set fix.dataDir absolute, so paths
      // in events should be either absolute OR relative to the workspace
      // root. Try both, prefer absolute.
      const resolveOnDisk = (p: string): string | null => {
        if (!p) return null
        if (path.isAbsolute(p) && fs.existsSync(p)) return p
        // Try relative-to-dataRoot, relative-to-session, relative-to-cwd
        const candidates = [
          path.join(fix.dataDir, p),
          path.join(sdir, p),
          path.resolve(p),
        ]
        return candidates.find(cand => fs.existsSync(cand)) ?? null
      }

      const beforePath = resolveOnDisk(before)
      const annotatedPath = resolveOnDisk(annotated)
      const afterPath = resolveOnDisk(after)

      assert(c, beforePath !== null, `phone_action[${actionIdx}].before resolves on disk (raw=${before.slice(0, 120)})`)
      assert(c, annotatedPath !== null, `phone_action[${actionIdx}].annotated resolves on disk`)
      assert(c, afterPath !== null, `phone_action[${actionIdx}].after resolves on disk`)

      for (const [kind, p] of [['before', beforePath], ['annotated', annotatedPath], ['after', afterPath]] as const) {
        if (!p) continue
        try {
          const meta = await sharp(p).metadata()
          assert(c, meta.format === 'png',
            `phone_action[${actionIdx}].${kind} is a valid PNG (got format=${meta.format})`)
        } catch (e) {
          assert(c, false, `phone_action[${actionIdx}].${kind} sharp metadata read (${(e as Error).message})`)
        }
      }

      // Byte diff: annotated.png must not be byte-identical to before.png.
      // sha256 catches "overlay didn't draw" regressions reliably; pHash was
      // too coarse and produced false-fails for legitimately-annotated
      // screenshots (a localized 50px tap circle won't flip an 8x8-mean bit).
      if (beforePath && annotatedPath) {
        try {
          const beforeSha = sha256File(beforePath)
          const annotatedSha = sha256File(annotatedPath)
          if (beforeSha !== null && annotatedSha !== null) {
            assert(c, beforeSha !== annotatedSha,
              `phone_action[${actionIdx}] annotated.png bytes differ from before.png (sha256)`)
          } else {
            assert(c, false,
              `phone_action[${actionIdx}] sha256 returned null (before=${beforeSha}, annotated=${annotatedSha})`)
          }
        } catch (e) {
          assert(c, false, `phone_action[${actionIdx}] sha256 diff (${(e as Error).message})`)
        }
      }
      actionIdx++
    }
  } finally {
    cleanupFixture(fix)
  }

  summary('S5', c)
  exitFromCounters('S5', c)
}

main().catch(err => {
  console.error('S5 runner threw:', err)
  process.exit(1)
})
