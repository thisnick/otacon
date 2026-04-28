/**
 * Integration tests for sandbox otacon commands against the real phone API.
 * Verifies each command type sends correct payloads (no 422 errors) and
 * the Phase A.2 allocation gate (NO_ALLOCATION / ALLOCATION_EXPIRED).
 *
 * Requires: phone-4 (phone-11031jec) reachable at otacon-pi.
 * Run: npx tsx tests/test-sandbox-commands.ts
 *
 * Also includes unit tests for argument parsers (isMutating, parseTapArgs, etc.)
 */
import 'dotenv/config'
import { OtaconClient } from 'otacon-cli/client'
import { isMutating, buildSandbox } from '../src/sandbox/build.js'
import { LocalBlobStore } from '../src/storage/blob.js'
import { AllocationContext } from '../src/sandbox/allocation-context.js'
import { createDb } from '../src/db/client.js'
import { conversations } from '../src/db/schema.js'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const HOST = 'https://otacon-pi.tail0437b8.ts.net:8080'
const PHONE_LOCAL_ID = 'phone-11031jec'
const BASE_URL = `${HOST}/phones/${PHONE_LOCAL_ID}`
const TEST_ACCOUNT = process.env.TEST_ACCOUNT_ID || 'xhs:test'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set — check src/orchestrator/.env')
  process.exit(1)
}
const db = createDb(DATABASE_URL)
const cleanupConvIds: string[] = []

async function cleanupAll() {
  for (const id of cleanupConvIds) {
    await db.execute(sql`DELETE FROM phone_allocations WHERE conversation_id = ${id}`).catch(() => {})
    await db.execute(sql`DELETE FROM conversations WHERE id = ${id}`).catch(() => {})
  }
}

// All identifiers we expect MUST NOT appear in tool stdout/stderr —
// the agent must never see the phone ID. (Phase A.2 invariant.)
const PHONE_IDENTIFIERS_FORBIDDEN_IN_AGENT_OUTPUT = [
  'phone-11031jec',
  '11031JEC202780',
  // The host URL itself may appear in error messages; that is acceptable.
]

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

// ---- Unit tests for isMutating ----

function testIsMutating() {
  console.log('\n--- isMutating ---')
  // Truly mutating verbs
  assert(isMutating('otacon tap 100 200') === true, 'otacon tap is mutating')
  assert(isMutating('otacon swipe 0 0 100 100') === true, 'otacon swipe is mutating')
  assert(isMutating('otacon key HOME') === true, 'otacon key is mutating')
  assert(isMutating('otacon type hello') === true, 'otacon type is mutating')
  assert(isMutating('otacon set-text ref text') === true, 'otacon set-text is mutating')
  assert(isMutating('otacon scroll ref') === true, 'otacon scroll is mutating')
  assert(isMutating('otacon long-tap ref') === true, 'otacon long-tap is mutating')
  assert(isMutating('otacon open https://example.com') === true, 'otacon open is mutating')
  assert(isMutating('otacon call dial 555') === true, 'otacon call is mutating')
  assert(isMutating('otacon sms send 555 hi') === true, 'otacon sms is mutating')
  // Phase A.2 reclassified as mutating because `apps launch/stop/install`,
  // `notifications dismiss/action`, and `clipboard set` mutate. The shared
  // registry uses a single isMutating flag per verb so these are conservative.
  assert(isMutating('otacon apps') === true, 'otacon apps is mutating (conservative)')
  assert(isMutating('otacon notifications') === true, 'otacon notifications is mutating (conservative)')
  assert(isMutating('otacon clipboard') === true, 'otacon clipboard is mutating (conservative)')
  // Truly read-only
  assert(isMutating('otacon screenshot') === false, 'otacon screenshot is NOT mutating')
  assert(isMutating('otacon snapshot') === false, 'otacon snapshot is NOT mutating')
  assert(isMutating('otacon info') === false, 'otacon info is NOT mutating')
  assert(isMutating('otacon contacts') === false, 'otacon contacts is NOT mutating')
  assert(isMutating('') === false, 'empty string is NOT mutating')
}

// ---- Integration tests via sandbox bash ----

async function testPhoneReachable() {
  console.log('\n--- phone reachable ---')
  const client = new OtaconClient(BASE_URL)
  try {
    const info = await client.info()
    assert(typeof info.model === 'string', `phone responds: ${info.model}`)
    const validStates = ['unlocked', 'locked', 'asleep', 'dozing', 'dreaming', 'unknown']
    assert(validStates.includes(info.screen_state as string), `screen_state valid: ${info.screen_state}`)
  } catch (e: any) {
    assert(false, `phone unreachable: ${e.message}`)
  }
}

type Bash = Awaited<ReturnType<typeof buildSandbox>>

async function makeFixtureConversation(): Promise<string> {
  const id = ulid()
  await db.insert(conversations).values({
    id,
    conversationKey: `test:sandbox:${id}`,
    blobPath: `conversations/${id}`,
    status: 'active',
  })
  cleanupConvIds.push(id)
  return id
}

async function withSandbox(fn: (bash: Bash) => Promise<void>) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'))
  const conversationId = await makeFixtureConversation()
  try {
    const blobStore = new LocalBlobStore(tmpDir)
    const allocCtx = new AllocationContext()
    const bash = await buildSandbox({
      blobStore,
      accountId: TEST_ACCOUNT,
      conversationId,
      db,
      allocCtx,
    })
    const r = await bash.exec('otacon-alloc provision 10')
    if (r.exitCode !== 0) {
      throw new Error(`otacon-alloc provision failed: ${r.stderr.trim()}`)
    }
    try {
      await fn(bash)
    } finally {
      await bash.exec('otacon-alloc release').catch(() => {})
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** Sandbox without provisioning — used to verify NO_ALLOCATION gate. */
async function withUnallocatedSandbox(fn: (bash: Bash) => Promise<void>) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-noalloc-'))
  const conversationId = await makeFixtureConversation()
  try {
    const blobStore = new LocalBlobStore(tmpDir)
    const allocCtx = new AllocationContext()
    const bash = await buildSandbox({
      blobStore,
      accountId: TEST_ACCOUNT,
      conversationId,
      db,
      allocCtx,
    })
    await fn(bash)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

function containsPhoneId(s: string): string | null {
  for (const id of PHONE_IDENTIFIERS_FORBIDDEN_IN_AGENT_OUTPUT) {
    if (s.includes(id)) return id
  }
  return null
}

async function testScreenshot() {
  console.log('\n--- screenshot ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon screenshot')
    assert(r.exitCode === 0, 'screenshot exit 0')
    assert(r.stdout.includes('screenshot captured'), `stdout: ${r.stdout.trim()}`)
  })
}

async function testSnapshot() {
  console.log('\n--- snapshot ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon snapshot')
    assert(r.exitCode === 0, 'snapshot text exit 0')
    assert(r.stdout.length > 50, `text snapshot has content (${r.stdout.length} chars)`)
  })
}

async function testSnapshotJson() {
  console.log('\n--- snapshot --json ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon snapshot --json')
    assert(r.exitCode === 0, 'snapshot json exit 0')
    let parsed: any
    try { parsed = JSON.parse(r.stdout) } catch { parsed = null }
    assert(Array.isArray(parsed), 'json snapshot returns array')
  })
}

async function testInfo() {
  console.log('\n--- info ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon info')
    assert(r.exitCode === 0, 'info exit 0')
    assert(r.stdout.includes('model'), 'info output includes model')
  })
}

async function testInfoJson() {
  console.log('\n--- info --json ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon info --json')
    assert(r.exitCode === 0, 'info json exit 0')
    let parsed: any
    try { parsed = JSON.parse(r.stdout) } catch { parsed = null }
    assert(parsed !== null && typeof parsed.model === 'string', 'json info has model field')
  })
}

async function testTapCoordinates() {
  console.log('\n--- tap coordinates ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon tap 540 1000')
    assert(r.exitCode === 0, `tap coords exit 0 (stderr: ${r.stderr.trim()})`)
    assert(r.stdout.includes('tapped'), `stdout: ${r.stdout.trim()}`)
  })
}

async function testTapByRef() {
  console.log('\n--- tap by ref ---')
  await withSandbox(async (bash) => {
    // Get a valid ref from snapshot — walk the tree to find a clickable node
    const snap = await bash.exec('otacon snapshot --json')
    let ref = 'e1' // fallback
    try {
      const nodes = JSON.parse(snap.stdout)
      const findRef = (n: any): string | null => {
        if (n.ref && n.clickable) return n.ref
        if (n.ref) return n.ref
        for (const child of (n.children || [])) {
          const found = findRef(child)
          if (found) return found
        }
        return null
      }
      for (const n of (Array.isArray(nodes) ? nodes : [nodes])) {
        const found = findRef(n)
        if (found) { ref = found; break }
      }
    } catch {}
    const r = await bash.exec(`otacon tap ${ref}`)
    // Accept either success OR "ref not found" (proves correct field was sent, not a 422)
    const noSchemaError = !r.stderr.includes('422') && !r.stderr.includes('Unprocessable')
    assert(noSchemaError, `tap by ref sends correct payload (ref=${ref}, exit=${r.exitCode}, stderr: ${r.stderr.trim()})`)
  })
}

async function testSwipe() {
  console.log('\n--- swipe ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon swipe 540 1200 540 600')
    assert(r.exitCode === 0, `swipe exit 0 (stderr: ${r.stderr.trim()})`)
    assert(r.stdout.includes('swiped'), `stdout: ${r.stdout.trim()}`)
  })
}

async function testSwipeWithDuration() {
  console.log('\n--- swipe with --duration ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon swipe 540 1200 540 600 --duration 500')
    assert(r.exitCode === 0, `swipe+duration exit 0 (stderr: ${r.stderr.trim()})`)
  })
}

async function testKey() {
  console.log('\n--- key ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon key HOME')
    assert(r.exitCode === 0, `key HOME exit 0 (stderr: ${r.stderr.trim()})`)
    assert(r.stdout.includes('sent key HOME'), `stdout: ${r.stdout.trim()}`)
  })
}

async function testKeyBack() {
  console.log('\n--- key BACK ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon key BACK')
    assert(r.exitCode === 0, `key BACK exit 0 (stderr: ${r.stderr.trim()})`)
  })
}

async function testScroll() {
  console.log('\n--- scroll ---')
  await withSandbox(async (bash) => {
    // Get a scrollable ref from snapshot
    const snap = await bash.exec('otacon snapshot --json')
    let ref = 'e1'
    try {
      const nodes = JSON.parse(snap.stdout)
      for (const n of nodes) {
        if (n.scrollable || n.class?.includes('ScrollView') || n.class?.includes('RecyclerView')) {
          ref = n.ref
          break
        }
      }
    } catch {}
    const r = await bash.exec(`otacon scroll ${ref}`)
    assert(r.exitCode === 0, `scroll exit 0 (ref=${ref}, stderr: ${r.stderr.trim()})`)
    assert(r.stdout.includes('scrolled'), `stdout: ${r.stdout.trim()}`)
  })
}

async function testScrollUp() {
  console.log('\n--- scroll --direction up ---')
  await withSandbox(async (bash) => {
    const snap = await bash.exec('otacon snapshot --json')
    let ref = 'e1'
    try {
      const nodes = JSON.parse(snap.stdout)
      for (const n of nodes) {
        if (n.scrollable || n.class?.includes('ScrollView') || n.class?.includes('RecyclerView')) {
          ref = n.ref
          break
        }
      }
    } catch {}
    const r = await bash.exec(`otacon scroll ${ref} --direction up`)
    assert(r.exitCode === 0, `scroll up exit 0 (ref=${ref}, stderr: ${r.stderr.trim()})`)
  })
}

async function testApps() {
  console.log('\n--- apps ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon apps')
    assert(r.exitCode === 0, 'apps list exit 0')
    assert(r.stdout.length > 10, `apps list has content (${r.stdout.length} chars)`)
  })
}

async function testNotifications() {
  console.log('\n--- notifications ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon notifications')
    assert(r.exitCode === 0, 'notifications exit 0')
    let parsed: any
    try { parsed = JSON.parse(r.stdout) } catch { parsed = null }
    assert(Array.isArray(parsed), 'notifications returns array')
  })
}

async function testClipboard() {
  console.log('\n--- clipboard ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon clipboard')
    assert(r.exitCode === 0, 'clipboard get exit 0')
  })
}

async function testContacts() {
  console.log('\n--- contacts ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon contacts')
    assert(r.exitCode === 0, 'contacts exit 0')
    let parsed: any
    try { parsed = JSON.parse(r.stdout) } catch { parsed = null }
    assert(Array.isArray(parsed), 'contacts returns array')
  })
}

async function testCallStatus() {
  console.log('\n--- call status ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon call status')
    assert(r.exitCode === 0, 'call status exit 0')
    let parsed: any
    try { parsed = JSON.parse(r.stdout) } catch { parsed = null }
    assert(parsed !== null && typeof parsed.state === 'string', `call state: ${parsed?.state}`)
  })
}

async function testRecordStatus() {
  console.log('\n--- record status ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon record status')
    assert(r.exitCode === 0, 'record status exit 0')
    let parsed: any
    try { parsed = JSON.parse(r.stdout) } catch { parsed = null }
    assert(parsed !== null && typeof parsed.recording === 'boolean', `recording: ${parsed?.recording}`)
  })
}

async function testSmsThreads() {
  console.log('\n--- sms threads ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon sms')
    assert(r.exitCode === 0, 'sms threads exit 0')
    let parsed: any
    try { parsed = JSON.parse(r.stdout) } catch { parsed = null }
    assert(Array.isArray(parsed), 'sms threads returns array')
  })
}

async function testUnknownCommand() {
  console.log('\n--- unknown command ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon bogus')
    assert(r.exitCode === 1, 'unknown command exit 1')
    const stderr = r.stderr.toLowerCase()
    assert(
      stderr.includes('unknown') && (stderr.includes('verb') || stderr.includes('command')),
      `stderr indicates unknown verb (got: ${r.stderr.trim()})`,
    )
  })
}

async function testNoArgs() {
  console.log('\n--- no args ---')
  await withSandbox(async (bash) => {
    const r = await bash.exec('otacon')
    assert(r.exitCode === 1, 'no args exit 1')
    assert(r.stderr.includes('Usage'), 'stderr shows usage')
  })
}

// ---- Phase A.2 allocation-gate tests ----

async function testNoAllocationBlocksCommands() {
  console.log('\n--- NO_ALLOCATION blocks otacon commands ---')
  const verbs = [
    'otacon snapshot',
    'otacon screenshot',
    'otacon info',
    'otacon tap 100 200',
    'otacon swipe 100 200 300 400',
    'otacon key HOME',
  ]
  await withUnallocatedSandbox(async (bash) => {
    for (const cmd of verbs) {
      const r = await bash.exec(cmd)
      assert(r.exitCode !== 0, `${cmd} fails without allocation (exit ${r.exitCode})`)
      const stderr = r.stderr.toLowerCase()
      const ok = stderr.includes('no allocation') || stderr.includes('alloc') || stderr.includes('provision')
      assert(ok, `${cmd} stderr mentions allocation/provision (got: ${r.stderr.trim()})`)
    }
  })
}

async function testProvisionThenSucceed() {
  console.log('\n--- after provision: commands succeed ---')
  await withUnallocatedSandbox(async (bash) => {
    const before = await bash.exec('otacon snapshot')
    assert(before.exitCode !== 0, 'snapshot before provision fails (sanity)')

    const prov = await bash.exec('otacon-alloc provision 10')
    assert(prov.exitCode === 0, `provision succeeds (stderr: ${prov.stderr.trim()})`)

    const after = await bash.exec('otacon snapshot')
    assert(after.exitCode === 0, `snapshot after provision succeeds (stderr: ${after.stderr.trim()})`)

    await bash.exec('otacon-alloc release')
  })
}

async function testReleaseThenBlock() {
  console.log('\n--- after release: commands fail again ---')
  await withUnallocatedSandbox(async (bash) => {
    const prov = await bash.exec('otacon-alloc provision 10')
    assert(prov.exitCode === 0, 'provision setup ok')

    const ok = await bash.exec('otacon snapshot')
    assert(ok.exitCode === 0, 'snapshot ok while held')

    const rel = await bash.exec('otacon-alloc release')
    assert(rel.exitCode === 0, `release succeeds (stderr: ${rel.stderr.trim()})`)

    const blocked = await bash.exec('otacon snapshot')
    assert(blocked.exitCode !== 0, 'snapshot after release fails')
  })
}

async function testAllocStatus() {
  console.log('\n--- otacon-alloc status reports state ---')
  await withUnallocatedSandbox(async (bash) => {
    const empty = await bash.exec('otacon-alloc status')
    assert(empty.exitCode === 0, `status (no alloc) exit 0 (stderr: ${empty.stderr.trim()})`)
    let parsed: any
    try { parsed = JSON.parse(empty.stdout) } catch { parsed = null }
    if (parsed) {
      assert(parsed.has_allocation === false, `has_allocation false (got ${parsed.has_allocation})`)
    } else {
      assert(empty.stdout.toLowerCase().includes('no'), `status mentions no-allocation (stdout: ${empty.stdout.trim()})`)
    }

    await bash.exec('otacon-alloc provision 10')
    const held = await bash.exec('otacon-alloc status')
    assert(held.exitCode === 0, 'status (held) exit 0')
    let parsedHeld: any
    try { parsedHeld = JSON.parse(held.stdout) } catch { parsedHeld = null }
    if (parsedHeld) {
      assert(parsedHeld.has_allocation === true, `has_allocation true (got ${parsedHeld.has_allocation})`)
      assert(typeof parsedHeld.expires_at === 'string', `expires_at present (got ${parsedHeld.expires_at})`)
      assert(typeof parsedHeld.time_remaining_seconds === 'number', `time_remaining_seconds present`)
    }

    await bash.exec('otacon-alloc release')
  })
}

async function testProvisionIdempotent() {
  console.log('\n--- otacon-alloc provision idempotent ---')
  await withUnallocatedSandbox(async (bash) => {
    const a = await bash.exec('otacon-alloc provision 10')
    assert(a.exitCode === 0, 'first provision ok')

    const b = await bash.exec('otacon-alloc provision 10')
    assert(b.exitCode === 0, `second provision ok (stderr: ${b.stderr.trim()})`)

    // Status should still report a single active allocation
    const st = await bash.exec('otacon-alloc status')
    let parsed: any
    try { parsed = JSON.parse(st.stdout) } catch { parsed = null }
    if (parsed) {
      assert(parsed.has_allocation === true, 'has_allocation still true after re-provision')
    }

    await bash.exec('otacon-alloc release')
  })
}

async function testAgentNeverSeesPhoneId() {
  console.log('\n--- agent never sees the phone ID in tool output ---')
  await withSandbox(async (bash) => {
    const cmds = [
      'otacon snapshot',
      'otacon info',
      'otacon screenshot',
      'otacon-alloc status',
    ]
    for (const cmd of cmds) {
      const r = await bash.exec(cmd)
      const stdoutLeak = containsPhoneId(r.stdout)
      const stderrLeak = containsPhoneId(r.stderr)
      assert(stdoutLeak === null, `${cmd} stdout contains no phone ID (leak: ${stdoutLeak})`)
      assert(stderrLeak === null, `${cmd} stderr contains no phone ID (leak: ${stderrLeak})`)
    }
  })
}

async function main() {
  console.log('=== Sandbox Command Tests ===')

  // Unit tests (no phone needed)
  testIsMutating()

  // Integration tests (require phone)
  console.log('\n--- Checking phone connectivity ---')
  await testPhoneReachable()

  // Phase A.2: allocation gate
  await testNoAllocationBlocksCommands()
  await testProvisionThenSucceed()
  await testReleaseThenBlock()
  await testAllocStatus()
  await testProvisionIdempotent()
  await testAgentNeverSeesPhoneId()

  // Read-only commands
  await testScreenshot()
  await testSnapshot()
  await testSnapshotJson()
  await testInfo()
  await testInfoJson()
  await testApps()
  await testNotifications()
  await testClipboard()
  await testContacts()
  await testCallStatus()
  await testRecordStatus()
  await testSmsThreads()

  // Mutating commands (these actually touch the phone)
  await testTapCoordinates()
  await testTapByRef()
  await testSwipe()
  await testSwipeWithDuration()
  await testKey()
  await testKeyBack()
  await testScroll()
  await testScrollUp()

  // Error handling
  await testUnknownCommand()
  await testNoArgs()

  await cleanupAll()
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  cleanupAll().finally(() => process.exit(1))
})
