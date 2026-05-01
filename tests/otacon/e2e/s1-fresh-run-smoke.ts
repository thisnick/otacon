/**
 * Pi-spike S1 — Fresh run smoke.
 *
 * Authoritative test for task #4 scenario S1. Verifies that a first-ever
 * `otacon run` against a freshly-bootstrapped `.otacon-data/` tree against
 * `xhs:test` workspace + `social-media-engagement` team produces:
 *
 *   - Exit code 0
 *   - Console markers in stdout: `▶ run`, `[user]`, agent text, `┌ bash$`,
 *     `└ exit`, `■ done` (one full happy path per task #3's console printer
 *     contract)
 *   - `.otacon-data/workspaces/xhs:test/teams/social-media-engagement/sessions/{id}/`
 *     exists with:
 *       * `messages.jsonl` (Pi format: ≥ system + user + ≥1 assistant message)
 *       * `events.jsonl` (OtaconEvent: ≥ system_set, user_message, ≥1 pi.message_*,
 *         pi.agent_end)
 *       * `session.json` ({status: 'completed', endedAt: nonzero})
 *       * `sandbox/` symlink tree with `env/`, `memory/`, `traces/`
 *   - `.../teams/social-media-engagement/last-session.txt` matches the session id
 *
 * Hardware: phone-4 + XHS canonical. Same env as phase 1-5.
 *
 * STATUS: SKELETON — assertions stubbed pending implementer (#3) handoff.
 *
 * Run:
 *   pnpm test:e2e:spike-pi:s1
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  ACCOUNT_ID,
  TEAM_NAME,
  bootstrapTODO,
  cleanupFixture,
  countLines,
  info,
  makeCounters,
  makeFixture,
  runOtacon,
  section,
  skeletonExit,
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
    section('0. Bootstrap (.otacon-data/ workspace + team)')
    bootstrapTODO(fix)

    section('1. Run otacon CLI (fresh, first-ever for this team)')
    // TODO[#4-S1]: run real command after implementer handoff:
    //   const res = runOtacon(
    //     ['run', '--workspace', ACCOUNT_ID, '--team', TEAM_NAME, PROMPT],
    //     fix.dataDir,
    //   )
    //   assert(c, res.status === 0, `otacon run exits 0 (got ${res.status})`)
    //
    //   for (const marker of ['▶ run', '[user]', '┌ bash$', '└ exit', '■ done']) {
    //     assert(c, res.stdout.includes(marker), `stdout contains "${marker}"`)
    //   }
    info(`(stub) otacon run invocation pending implementer handoff`)

    section('2. Filesystem assertions')
    // TODO[#4-S1]: enumerate sessions/ dir, pick the first session id:
    //   const sessionsRoot = path.join(fix.teamStateDir, 'sessions')
    //   const sessionIds = fs.readdirSync(sessionsRoot)
    //   assert(c, sessionIds.length === 1, `exactly one session created (got ${sessionIds.length})`)
    //   const sid = sessionIds[0]
    //   const sdir = path.join(sessionsRoot, sid)
    //
    //   assert(c, fs.existsSync(path.join(sdir, 'messages.jsonl')), 'messages.jsonl exists')
    //   assert(c, fs.existsSync(path.join(sdir, 'events.jsonl')), 'events.jsonl exists')
    //   assert(c, fs.existsSync(path.join(sdir, 'session.json')), 'session.json exists')
    //
    //   const msgLines = countLines(path.join(sdir, 'messages.jsonl'))
    //   assert(c, msgLines >= 3, `messages.jsonl has ≥3 lines (system+user+assistant) (got ${msgLines})`)
    //
    //   const evLines = countLines(path.join(sdir, 'events.jsonl'))
    //   assert(c, evLines >= 3, `events.jsonl has ≥3 lines (got ${evLines})`)
    //
    //   const session = JSON.parse(fs.readFileSync(path.join(sdir, 'session.json'), 'utf-8'))
    //   assert(c, session.status === 'completed', `session.status === 'completed' (got ${session.status})`)
    //   assert(c, Number(session.endedAt) > 0, `session.endedAt is non-zero`)
    //
    //   const sandbox = path.join(sdir, 'sandbox')
    //   assert(c, fs.existsSync(sandbox), 'sandbox/ dir exists')
    //   for (const link of ['env', 'memory', 'traces']) {
    //     const lp = path.join(sandbox, link)
    //     assert(c, fs.existsSync(lp), `sandbox/${link} exists`)
    //     assert(c, fs.lstatSync(lp).isSymbolicLink(), `sandbox/${link} is a symlink`)
    //   }
    //
    //   const lastSession = fs.readFileSync(
    //     path.join(fix.teamStateDir, 'last-session.txt'), 'utf-8',
    //   ).trim()
    //   assert(c, lastSession === sid, `last-session.txt matches sid (got ${lastSession})`)
    //
    // Phase 5 false-pass lesson: ALSO scan events.jsonl for required event
    // kinds before declaring success — completion alone isn't enough.
    //   const events = readLines(path.join(sdir, 'events.jsonl')).map(l => JSON.parse(l))
    //   const kinds = new Set(events.map(e => e.kind === 'pi' ? `pi.${e.event.type}` : e.kind))
    //   for (const required of ['system_set', 'user_message', 'pi.agent_end']) {
    //     assert(c, kinds.has(required), `events.jsonl has at least one ${required} event`)
    //   }
    info(`(stub) FS assertions pending implementer handoff`)
  } finally {
    cleanupFixture(fix)
  }

  summary('S1', c)
  skeletonExit('S1', c)
}

main().catch(err => {
  console.error('S1 runner threw:', err)
  process.exit(1)
})
