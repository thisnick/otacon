/**
 * Pi-spike S6 — Sandbox ACL.
 *
 * Authoritative test for task #4 scenario S6 (RELAXED scope per lead +
 * implementer's documented spike-acceptable deviation):
 *
 *   "sandbox/ dir does not directly contain credentials.json"
 *
 *   Escape via `..` (e.g. `cat ../credentials.json` from sandbox cwd) is
 *   a documented limitation (ACL-P2), NOT a regression. Per implementer:
 *   bash sandbox root = workspace dir, sandbox cwd = sessions/<sid>/sandbox.
 *
 * What this scenario verifies:
 *
 *   FILESYSTEM-DRIVEN (no agent involved):
 *     - sandbox/ does NOT contain a credentials.json entry directly
 *     - sandbox/ symlinks (env/, memory/, traces/) are present
 *     - The link target dirs (env/, memory/) do not contain credentials.json
 *
 *   FIXTURE PROBE:
 *     - We drop a fake credentials.json with a unique canary string into
 *       workspaces/xhs:test/credentials.json BEFORE the run.
 *     - After the agent run, scan stdout + events.jsonl + messages.jsonl
 *       for the canary. None should contain it (relaxed scope only fires
 *       when the agent stays inside sandbox/; it MAY find it via `..`,
 *       which is the documented limitation — we report this as INFO, not
 *       a failure).
 *
 * Run:
 *   pnpm test:e2e:orchestrator:s6
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
  resolvePhoneBaseUrl,
  runOtaconRun,
  section,
  seedSpike,
  sessionDirOf,
  summary,
} from './helpers/spike.js'

const PROMPT_PROBE =
  process.env.OTACON_SPIKE_S6_PROMPT ??
  'list every file you can see in your current sandbox dir. then exit.'

const CANARY = 'evaluator-canary-12345-S6'

async function main(): Promise<void> {
  const c = makeCounters()
  const fix = makeFixture('s6')

  console.log(`\n=== Pi-spike S6: sandbox ACL (relaxed scope) ===`)
  console.log(`dataDir = ${fix.dataDir}`)

  try {
    section('0. Seed + drop fake credentials.json with canary')
    const seed = seedSpike(fix)
    assert(c, seed.status === 0, `seed exits 0`)

    const credFile = path.join(fix.workspaceDir, 'credentials.json')
    fs.writeFileSync(credFile, JSON.stringify({ secret: CANARY }, null, 2), 'utf-8')
    assert(c, fs.existsSync(credFile), `credentials.json fixture written`)

    let phoneUrl = ''
    try { phoneUrl = await resolvePhoneBaseUrl() } catch (e) {
      info(`resolvePhone failed: ${(e as Error).message}`)
    }

    section('1. Run otacon (so the sandbox dir gets built)')
    const r = runOtaconRun(fix, {
      message: PROMPT_PROBE,
      resume: 'new',
      phone: phoneUrl || undefined,
      autoApprove: true,
    })
    assert(c, r.status === 0, `otacon run exits 0 (got ${r.status})`)

    const sids = listSessionIds(fix)
    const sid = sids[sids.length - 1] ?? ''
    if (!sid) {
      summary('S6', c)
      exitFromCounters('S6', c)
    }
    const sdir = sessionDirOf(fix, sid)
    const sandbox = path.join(sdir, 'sandbox')
    assert(c, fs.existsSync(sandbox), `sandbox/ dir exists`)

    section('2. FS probe: sandbox/ does NOT directly contain credentials.json')
    const sbEntries = fs.readdirSync(sandbox)
    info(`sandbox/ entries: ${sbEntries.join(', ')}`)
    assert(c, !sbEntries.includes('credentials.json'),
      `sandbox/ does not directly contain credentials.json`)
    // Each symlink should be present.
    for (const link of ['env', 'memory', 'traces']) {
      assert(c, sbEntries.includes(link), `sandbox/${link} present`)
    }

    section('3. Symlink-target probe: env/, memory/ do not contain credentials.json')
    const envTarget = fs.realpathSync(path.join(sandbox, 'env'))
    const memTarget = fs.realpathSync(path.join(sandbox, 'memory'))
    const envEntries = fs.readdirSync(envTarget)
    const memEntries = fs.readdirSync(memTarget)
    info(`env/ → ${envTarget}: ${envEntries.join(', ')}`)
    info(`memory/ → ${memTarget}: ${memEntries.join(', ')}`)
    assert(c, !envEntries.includes('credentials.json'),
      `sandbox/env target dir does not contain credentials.json`)
    assert(c, !memEntries.includes('credentials.json'),
      `sandbox/memory target dir does not contain credentials.json`)

    section('4. Canary leak check (relaxed — `..` escape is documented limitation)')
    const stdoutHasCanary = r.stdout.includes(CANARY)
    const stderrHasCanary = r.stderr.includes(CANARY)
    let eventsHaveCanary = false
    let messagesHaveCanary = false
    try {
      eventsHaveCanary = fs.readFileSync(path.join(sdir, 'events.jsonl'), 'utf-8').includes(CANARY)
      messagesHaveCanary = fs.readFileSync(path.join(sdir, 'messages.jsonl'), 'utf-8').includes(CANARY)
    } catch { /* ignore */ }

    if (stdoutHasCanary || stderrHasCanary || eventsHaveCanary || messagesHaveCanary) {
      info(`canary appeared (documented ACL-P2 limitation, NOT a regression):`)
      info(`  stdout=${stdoutHasCanary} stderr=${stderrHasCanary} events=${eventsHaveCanary} messages=${messagesHaveCanary}`)
      info(`  agent escaped via "..", which the spike's relaxed-ACL scope explicitly allows.`)
    } else {
      info(`canary did NOT leak (good — agent stayed inside sandbox/).`)
    }
    // Per task #4 + lead's relaxed scope: the actual sign-off assertion is
    // only the FS-driven "sandbox/ does not directly contain credentials.json"
    // — which the section-2 + section-3 assertions cover. Canary leak is
    // surfaced as INFO, not a FAIL.
  } finally {
    cleanupFixture(fix)
  }

  summary('S6', c)
  exitFromCounters('S6', c)
}

main().catch(err => {
  console.error('S6 runner threw:', err)
  process.exit(1)
})
