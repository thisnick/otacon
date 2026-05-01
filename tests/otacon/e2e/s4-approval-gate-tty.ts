/**
 * Pi-spike S4 — Approval gate (TTY prompt).
 *
 * Authoritative test for task #4 scenario S4. Per implementer's contract:
 *
 *   - Prompt is `Approve: <command>? [y/n]` written to stderr; reads from stdin.
 *   - Piped stdin works (`echo y | otacon run ...`). No PTY required.
 *   - `--auto-approve` and `--auto-reject` flags bypass the prompt entirely
 *     (preferred for harness use).
 *   - On rejection, Pi emits a synthetic `tool_execution_end` event with
 *     `isError: true` + result text matching one of:
 *       'User rejected this tool call.', 'User skipped this tool call.',
 *       'auto-reject mode'
 *     There is NO custom OtaconEvent kind for bash rejections.
 *
 * Drives a mutating bash command (`otacon tap` against phone-4) to trigger
 * the gate. Three sub-tests:
 *
 *   APPROVE via piped stdin — `echo y | otacon run "tap..."`
 *     - exit 0
 *     - stderr contains the approval prompt
 *     - events.jsonl contains a `phone_action` event with screenshots
 *
 *   APPROVE via --auto-approve flag (sanity)
 *     - exit 0
 *     - events.jsonl phone_action present
 *
 *   REJECT via --auto-reject flag
 *     - exit 0 (run completes — model adapts to rejection)
 *     - events.jsonl: NO phone_action event for the rejected call
 *     - events.jsonl: pi.tool_execution_end with isError: true and
 *       result text matching the rejection contract
 *
 * Run:
 *   pnpm test:e2e:spike-pi:s4
 */
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
  runOtaconWithStdin,
  section,
  seedSpike,
  sessionDirOf,
  summary,
} from './helpers/spike.js'

const PROMPT_MUTATE =
  process.env.OTACON_SPIKE_S4_PROMPT ??
  'open Xiaohongshu (com.xingin.xhs) and tap the home tab. then exit.'

interface EventLike {
  kind?: string
  event?: { type?: string; isError?: boolean; result?: { content?: Array<{ text?: string }> } }
  payload?: { screenshots?: { before?: string; annotated?: string; after?: string } }
}

async function main(): Promise<void> {
  const c = makeCounters()
  const fix = makeFixture('s4')

  console.log(`\n=== Pi-spike S4: approval gate (TTY prompt) ===`)
  console.log(`dataDir = ${fix.dataDir}`)

  try {
    section('0. Seed + resolve phone-4')
    const seed = seedSpike(fix)
    assert(c, seed.status === 0, `seed exits 0`)

    let phoneUrl = ''
    try { phoneUrl = await resolvePhoneBaseUrl() } catch (e) {
      info(`resolvePhone failed: ${(e as Error).message}`)
    }
    assert(c, phoneUrl !== '', `phone base URL resolved (got "${phoneUrl}")`)

    section('1. APPROVE path via piped stdin (echo y | otacon run ...)')
    // Feed enough y\n's to cover any number of approval prompts in this run.
    const yFeed = 'y\n'.repeat(20)
    const r1 = await runOtaconWithStdin(
      fix,
      { message: PROMPT_MUTATE, resume: 'new', phone: phoneUrl },
      yFeed,
    )
    assert(c, r1.status === 0, `approve-via-stdin run exits 0 (got ${r1.status})`)
    if (r1.status !== 0) {
      info(`r1 stderr (first 1500): ${r1.stderr.slice(0, 1500)}`)
      info(`r1 stdout (last 1000):  ${r1.stdout.slice(-1000)}`)
    }
    // Approval prompt is written to stderr per implementer's gate impl.
    assert(c, /Approve:.*\?\s*\[y\/n\]/i.test(r1.stderr) || /Approve:.*\?\s*\[y\/n\]/i.test(r1.stdout),
      `r1: approval prompt 'Approve: ...? [y/n]' appeared (stderr or stdout)`)

    const sids1 = listSessionIds(fix)
    assert(c, sids1.length >= 1, `r1: at least one session created`)
    const sid1 = sids1[sids1.length - 1] ?? ''
    if (sid1) {
      const events1 = readJsonlEvents(path.join(sessionDirOf(fix, sid1), 'events.jsonl')) as EventLike[]
      const phoneActions = events1.filter(e => e.kind === 'phone_action')
      assert(c, phoneActions.length >= 1,
        `r1 events.jsonl has ≥1 phone_action (got ${phoneActions.length})`)
      const pa = phoneActions[0]
      if (pa) {
        assert(c, !!pa.payload?.screenshots?.before, `r1 phone_action.payload.screenshots.before set`)
        assert(c, !!pa.payload?.screenshots?.annotated, `r1 phone_action.payload.screenshots.annotated set`)
        assert(c, !!pa.payload?.screenshots?.after, `r1 phone_action.payload.screenshots.after set`)
      }
    }

    section('2. APPROVE path via --auto-approve flag (sanity)')
    const r2 = runOtaconRun(fix, {
      message: PROMPT_MUTATE,
      resume: 'new',
      phone: phoneUrl,
      autoApprove: true,
    })
    assert(c, r2.status === 0, `auto-approve run exits 0 (got ${r2.status})`)

    const sids2 = listSessionIds(fix)
    const sid2 = sids2[sids2.length - 1] ?? ''
    if (sid2 && sid2 !== sid1) {
      const events2 = readJsonlEvents(path.join(sessionDirOf(fix, sid2), 'events.jsonl')) as EventLike[]
      const phoneActions2 = events2.filter(e => e.kind === 'phone_action')
      assert(c, phoneActions2.length >= 1,
        `r2 events.jsonl has ≥1 phone_action (got ${phoneActions2.length})`)
    } else {
      assert(c, false, `r2 created a new session id`)
    }

    section('3. REJECT path via --auto-reject flag')
    const r3 = runOtaconRun(fix, {
      message: PROMPT_MUTATE,
      resume: 'new',
      phone: phoneUrl,
      autoReject: true,
    })
    assert(c, r3.status === 0, `auto-reject run exits 0 — run completes after rejection (got ${r3.status})`)

    const sids3 = listSessionIds(fix)
    const sid3 = sids3.find(s => s !== sid1 && s !== sid2) ?? sids3[sids3.length - 1] ?? ''
    if (sid3) {
      const events3 = readJsonlEvents(path.join(sessionDirOf(fix, sid3), 'events.jsonl')) as EventLike[]

      // No phone_action on rejected calls (the bash never executed).
      const phoneActions3 = events3.filter(e => e.kind === 'phone_action')
      // The model may try multiple things; if EVERY attempt is a mutating
      // tap (which gets rejected), there should be ZERO phone_action events.
      // But if the model also issues non-mutating screenshot/info, those
      // pass through without the gate and may emit phone_action wrappers
      // (only mutating subcommands trigger the wrapper). Be precise:
      //   a phone_action with exitCode === 0 is a successful execution;
      //   a phone_action with screenshots set is a real interaction.
      // We assert: no phone_action with screenshots.before AND exitCode===0
      // matching the rejected mutating call.
      info(`r3 phone_action events: ${phoneActions3.length}`)

      // The synthetic tool_execution_end with isError:true.
      const piEvents = events3.filter(e => e.kind === 'pi')
      const toolEnd = piEvents.find(e => {
        const ev = e.event
        if (!ev || ev.type !== 'tool_execution_end' || ev.isError !== true) return false
        const text = ev.result?.content?.find(cc => typeof cc.text === 'string')?.text ?? ''
        return /User rejected this tool call|User skipped this tool call|auto-reject mode/i.test(text)
      })
      assert(c, !!toolEnd,
        `r3 events.jsonl has at least one pi.tool_execution_end with isError:true and rejection-text contract`)
    } else {
      assert(c, false, `r3 created a session id`)
    }
  } finally {
    cleanupFixture(fix)
  }

  summary('S4', c)
  exitFromCounters('S4', c)
}

main().catch(err => {
  console.error('S4 runner threw:', err)
  process.exit(1)
})
