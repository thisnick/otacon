/**
 * Unit tests for `src/orchestrator/src/sandbox/mutating.ts`.
 *
 * Covers:
 *   - top-level mutating verbs (tap, swipe, scroll, key, set-text, type, open)
 *   - top-level read-only verbs (info, snapshot, screenshot, contacts)
 *   - subcommand-aware verbs (apps, call, clipboard, notifications, record, sms)
 *   - default subcommand handling (e.g. bare `otacon apps` → apps list → read-only)
 *   - non-otacon commands (cat, ls, echo) — always read-only
 *   - bash-string parsing edge cases (extra whitespace, quoted args)
 *
 * Run: npx tsx tests/orchestrator/unit/test-mutating.ts
 */
import { isMutating, isMutatingOtacon } from '../../../src/orchestrator/src/sandbox/mutating.js'

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  PASS  ${msg}`)
    passed++
  } else {
    console.log(`  FAIL  ${msg}`)
    failed++
  }
}

async function main() {
  console.log('mutating.ts')

  // ── top-level mutating verbs ────────────────────────────────
  assert(isMutatingOtacon('tap', ['540', '1200']), 'tap with coords is mutating')
  assert(isMutatingOtacon('tap', ['e5']), 'tap with ref is mutating')
  assert(isMutatingOtacon('long-tap', ['e5']), 'long-tap is mutating')
  assert(isMutatingOtacon('swipe', ['1', '2', '3', '4']), 'swipe is mutating')
  assert(isMutatingOtacon('scroll', ['e3']), 'scroll is mutating')
  assert(isMutatingOtacon('key', ['HOME']), 'key is mutating')
  assert(isMutatingOtacon('set-text', ['e5', 'hello']), 'set-text is mutating')
  assert(isMutatingOtacon('type', ['e5', 'hello']), 'type is mutating')
  assert(isMutatingOtacon('open', ['https://example.com']), 'open is mutating')

  // ── top-level read-only verbs ───────────────────────────────
  assert(!isMutatingOtacon('info', []), 'info is read-only')
  assert(!isMutatingOtacon('snapshot', []), 'snapshot is read-only')
  assert(!isMutatingOtacon('screenshot', []), 'screenshot is read-only')
  assert(!isMutatingOtacon('contacts', []), 'contacts is read-only')

  // ── apps subcommands ────────────────────────────────────────
  assert(!isMutatingOtacon('apps', []), 'bare apps (defaults to list) is read-only')
  assert(!isMutatingOtacon('apps', ['list']), 'apps list is read-only')
  assert(!isMutatingOtacon('apps', ['running']), 'apps running is read-only')
  assert(isMutatingOtacon('apps', ['launch', 'com.x']), 'apps launch is mutating')
  assert(isMutatingOtacon('apps', ['stop', 'com.x']), 'apps stop is mutating')
  assert(isMutatingOtacon('apps', ['install', '/tmp/x.apk']), 'apps install is mutating')

  // ── sms subcommands ─────────────────────────────────────────
  assert(!isMutatingOtacon('sms', []), 'bare sms (defaults to list) is read-only')
  assert(!isMutatingOtacon('sms', ['list']), 'sms list is read-only')
  assert(!isMutatingOtacon('sms', ['read', '12']), 'sms read is read-only')
  assert(isMutatingOtacon('sms', ['send', '+1...', 'hi']), 'sms send is mutating')

  // ── clipboard subcommands ───────────────────────────────────
  assert(!isMutatingOtacon('clipboard', []), 'bare clipboard (defaults to get) is read-only')
  assert(!isMutatingOtacon('clipboard', ['get']), 'clipboard get is read-only')
  assert(isMutatingOtacon('clipboard', ['set', 'hello']), 'clipboard set is mutating')

  // ── notifications subcommands ───────────────────────────────
  assert(!isMutatingOtacon('notifications', []), 'bare notifications (defaults to list) is read-only')
  assert(!isMutatingOtacon('notifications', ['list']), 'notifications list is read-only')
  assert(isMutatingOtacon('notifications', ['dismiss', 'k']), 'notifications dismiss is mutating')
  assert(isMutatingOtacon('notifications', ['action', 'k', '0']), 'notifications action is mutating')

  // ── record subcommands ──────────────────────────────────────
  assert(!isMutatingOtacon('record', []), 'bare record (defaults to status) is read-only')
  assert(!isMutatingOtacon('record', ['status']), 'record status is read-only')
  assert(isMutatingOtacon('record', ['start']), 'record start is mutating')
  assert(isMutatingOtacon('record', ['stop']), 'record stop is mutating')

  // ── call subcommands ────────────────────────────────────────
  assert(!isMutatingOtacon('call', []), 'bare call (defaults to status) is read-only')
  assert(!isMutatingOtacon('call', ['status']), 'call status is read-only')
  assert(isMutatingOtacon('call', ['dial', '+1...']), 'call dial is mutating')
  assert(isMutatingOtacon('call', ['answer']), 'call answer is mutating')
  assert(isMutatingOtacon('call', ['hangup']), 'call hangup is mutating')

  // ── unknown verb ────────────────────────────────────────────
  assert(!isMutatingOtacon('not-a-verb', []), 'unknown verb is not mutating')

  // ── bash-string predicate ───────────────────────────────────
  assert(isMutating('otacon tap e5'), 'isMutating: otacon tap e5')
  assert(!isMutating('otacon snapshot'), 'isMutating: otacon snapshot is read-only')
  assert(!isMutating('otacon apps list'), 'isMutating: otacon apps list is read-only')
  assert(isMutating('otacon apps launch com.x'), 'isMutating: otacon apps launch is mutating')
  assert(!isMutating('otacon apps'), 'isMutating: otacon apps (bare → list) is read-only')
  assert(!isMutating('otacon sms list'), 'isMutating: otacon sms list is read-only')
  assert(isMutating('otacon sms send +1 hi'), 'isMutating: otacon sms send is mutating')

  // ── non-otacon commands always non-mutating ─────────────────
  assert(!isMutating('cat /etc/hosts'), 'isMutating: cat is read-only')
  assert(!isMutating('ls -la'), 'isMutating: ls is read-only')
  assert(!isMutating('echo hello'), 'isMutating: echo is read-only')
  assert(!isMutating(''), 'isMutating: empty string is read-only')

  // ── whitespace & arg handling ───────────────────────────────
  assert(isMutating('   otacon tap e5   '), 'isMutating tolerates leading/trailing whitespace')
  assert(isMutating('otacon  tap   e5'), 'isMutating tolerates collapsed/extra inner whitespace')

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
