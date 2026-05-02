/**
 * Pi-spike S7 — Resume preserves Pi format (round-trip).
 *
 * Authoritative test for task #4 scenario S7. Per implementer's contract:
 *
 *   - No dedicated `resume-check` subcommand was implemented (deferred).
 *   - Use `pnpm --filter orchestrator orchestrator sessions list -w ... -t ... --json`
 *     to enumerate sessions, then read `messages.jsonl` directly.
 *   - The actual resume code path is what `otacon run` (default = continue
 *     last session) exercises — calling `agent.continue(messages)` under
 *     the hood. So a successful "second run" with growth in messages.jsonl
 *     transitively proves the round-trip works.
 *
 * Verifies:
 *
 *   - `sessions list --json` lists the established session with status
 *     'completed' and matching modelId.
 *   - `messages.jsonl` parses as Pi `Message[]` (every line valid JSON,
 *     each line has a `role` field of 'user' / 'assistant' / 'toolResult').
 *   - The default-resume run grows messages.jsonl line count + byte length
 *     (proves agent.continue accepted the prior transcript without parse
 *     error and produced new turns).
 *
 * No phone hardware required for the assertion logic — but the runtime's
 * lead prompt may try `otacon-alloc provision` so we still pass --phone.
 *
 * Run:
 *   pnpm test:e2e:orchestrator:s7
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  ACCOUNT_ID,
  REPO_ROOT,
  TEAM_NAME,
  assert,
  cleanupFixture,
  countLines,
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

interface SessionListEntry {
  id: string
  status: string
  startedAt: number | null
  endedAt: number | null
  modelId: string | null
}

async function main(): Promise<void> {
  const c = makeCounters()
  const fix = makeFixture('s7')

  console.log(`\n=== Pi-spike S7: resume Pi format round-trip ===`)
  console.log(`dataDir = ${fix.dataDir}`)

  try {
    section('0. Seed')
    const seed = seedSpike(fix)
    assert(c, seed.status === 0, `seed exits 0`)

    let phoneUrl = ''
    try { phoneUrl = await resolvePhoneBaseUrl() } catch (e) {
      info(`resolvePhone failed: ${(e as Error).message}`)
    }

    section('1. First run (populate messages.jsonl)')
    const r1 = runOtaconRun(fix, {
      message: 'pick a memorable color word and tell me what it is. then exit.',
      phone: phoneUrl || undefined,
      autoApprove: true,
    })
    assert(c, r1.status === 0, `first run exits 0 (got ${r1.status})`)

    const sids = listSessionIds(fix)
    const sid = sids[0] ?? ''
    if (!sid) {
      summary('S7', c)
      exitFromCounters('S7', c)
    }
    const sdir = sessionDirOf(fix, sid)
    const msgFile = path.join(sdir, 'messages.jsonl')
    const msgLines1 = countLines(msgFile)
    info(`messages.jsonl after r1: ${msgLines1} lines`)

    section('2. sessions list --json includes our session')
    const listRes = spawnSync('pnpm', [
      '--filter', 'orchestrator', 'orchestrator', 'sessions', 'list',
      '-w', ACCOUNT_ID, '-t', TEAM_NAME, '--json',
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, ORCHESTRATOR_DATA_DIR: fix.dataDir },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert(c, listRes.status === 0, `sessions list --json exits 0 (got ${listRes.status})`)
    let entries: SessionListEntry[] = []
    try {
      entries = JSON.parse(listRes.stdout) as SessionListEntry[]
    } catch (e) {
      assert(c, false, `sessions list --json output parses (${(e as Error).message})`)
      info(`stdout (first 500): ${listRes.stdout.slice(0, 500)}`)
    }
    const found = entries.find(e => e.id === sid)
    assert(c, !!found, `sessions list contains our session id`)
    if (found) {
      assert(c, found.status === 'completed', `session entry status === 'completed' (got ${found.status})`)
      assert(c, typeof found.modelId === 'string' && (found.modelId ?? '').length > 0,
        `session entry has non-empty modelId (got ${found.modelId})`)
    }

    section('3. messages.jsonl parses as Pi Message[] (each line valid JSON with role)')
    const lines = fs.readFileSync(msgFile, 'utf-8').split('\n').filter(Boolean)
    let allParse = true
    let allHaveRole = true
    for (const line of lines) {
      try {
        const m = JSON.parse(line) as { role?: string }
        if (typeof m.role !== 'string') allHaveRole = false
        if (!['user', 'assistant', 'toolResult'].includes(m.role ?? '')) allHaveRole = false
      } catch {
        allParse = false
      }
    }
    assert(c, allParse, `every messages.jsonl line is valid JSON`)
    assert(c, allHaveRole, `every messages.jsonl line has role ∈ {user, assistant, toolResult}`)

    section('4. Round-trip via default-resume run (agent.continue under the hood)')
    const r2 = runOtaconRun(fix, {
      message: 'now tell me the same color word again, then exit.',
      phone: phoneUrl || undefined,
      autoApprove: true,
    })
    assert(c, r2.status === 0,
      `default-resume run exits 0 — agent.continue accepted prior messages.jsonl (got ${r2.status})`)
    if (r2.status !== 0) {
      info(`r2 stderr (first 1500): ${r2.stderr.slice(0, 1500)}`)
    }

    const msgLines2 = countLines(msgFile)
    info(`messages.jsonl after r2: ${msgLines2} lines`)
    assert(c, msgLines2 > msgLines1,
      `messages.jsonl grew after default-resume run (${msgLines1} → ${msgLines2})`)

    // Phase 5 false-pass: verify r2's last assistant message has stopReason !== 'error'.
    let r2Ok = false
    try {
      const linesR2 = fs.readFileSync(msgFile, 'utf-8').split('\n').filter(Boolean)
      const last = JSON.parse(linesR2[linesR2.length - 1])
      r2Ok = last.role === 'assistant' && last.stopReason !== 'error'
    } catch { /* fall through */ }
    assert(c, r2Ok,
      `r2's last assistant message has stopReason !== 'error' (Phase 5 false-pass guard — proves the resumed turn produced real work)`)
  } finally {
    cleanupFixture(fix)
  }

  summary('S7', c)
  exitFromCounters('S7', c)
}

main().catch(err => {
  console.error('S7 runner threw:', err)
  process.exit(1)
})
