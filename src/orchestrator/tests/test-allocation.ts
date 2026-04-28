/**
 * Phone allocation service tests.
 *
 * Verifies the lease lifecycle described in the Phase A.2 plan:
 *   - Idempotent provision (same conversation re-acquire = no new row)
 *   - Mutual exclusion (other conversation acquire while held → PhoneBusyError)
 *   - Expired lease frees the phone without explicit eviction
 *   - Release is idempotent and is the ONLY UPDATE in the table
 *   - getActive returns latest non-expired row
 *   - InvalidDurationError on bad duration values
 *
 * Requires:
 *   - DATABASE_URL in src/orchestrator/.env, schema migrated
 *   - `xhs:test` account seeded with a phone credential whose phone_number
 *     resolves to a registry phone (the registry is reached for hostUrl).
 *
 * Run: npx tsx tests/test-allocation.ts
 */
import 'dotenv/config'
import { ulid } from 'ulid'
import { sql } from 'drizzle-orm'
import { createDb } from '../src/db/client.js'
import { conversations, phoneAllocations } from '../src/db/schema.js'
import {
  acquire,
  release,
  getActive,
  PhoneBusyError,
  InvalidDurationError,
} from '../src/services/allocations.js'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set — check src/orchestrator/.env')
  process.exit(1)
}

const TEST_ACCOUNT = process.env.TEST_ACCOUNT_ID || 'xhs:test'
const db = createDb(DATABASE_URL)

let passed = 0
let failed = 0
const cleanupConvIds: string[] = []
let TEST_PHONE_ID = ''  // resolved by an initial acquire on a throwaway conversation

function assert(condition: boolean, msg: string) {
  if (condition) { console.log(`  PASS  ${msg}`); passed++ }
  else { console.log(`  FAIL  ${msg}`); failed++ }
}

async function makeConversation(): Promise<string> {
  const id = ulid()
  await db.insert(conversations).values({
    id,
    conversationKey: `test:alloc:${id}`,
    blobPath: `conversations/${id}`,
    status: 'active',
  })
  cleanupConvIds.push(id)
  return id
}

async function cleanup() {
  if (cleanupConvIds.length > 0) {
    // Drizzle's sql template doesn't auto-bind JS arrays to PG arrays;
    // delete one row at a time to keep cleanup robust across drivers.
    for (const id of cleanupConvIds) {
      await db.execute(sql`DELETE FROM phone_allocations WHERE conversation_id = ${id}`)
    }
    for (const id of cleanupConvIds) {
      await db.execute(sql`DELETE FROM conversations WHERE id = ${id}`)
    }
  }
}

async function expiringInsert(conversationId: string, secondsAgo: number, expiresInSec: number) {
  const id = ulid()
  await db.execute(sql`
    INSERT INTO phone_allocations (id, phone_id, conversation_id, allocated_at, expires_at)
    VALUES (
      ${id},
      ${TEST_PHONE_ID},
      ${conversationId},
      now() - (${secondsAgo} * interval '1 second'),
      now() + (${expiresInSec} * interval '1 second')
    )
  `)
  return id
}

// ----- Tests -----

async function testAcquireHappy() {
  console.log('\n--- acquire happy path ---')
  const convId = await makeConversation()

  const before = Date.now()
  const r = await acquire(db, { accountId: TEST_ACCOUNT, conversationId: convId, durationMin: 10 })

  assert(typeof r.allocationId === 'string' && r.allocationId.length > 0,
    `returns allocationId (${r.allocationId})`)
  assert(r.expiresAt instanceof Date, 'expiresAt is a Date')
  assert(r.expiresAt.getTime() > before, 'expiresAt is in the future')
  const deltaSec = (r.expiresAt.getTime() - before) / 1000
  assert(deltaSec >= 590 && deltaSec <= 620, `expiresAt ≈ now + 10m (got ${deltaSec.toFixed(1)}s)`)
  assert(typeof r.phoneId === 'string' && r.phoneId.length > 0, `phoneId resolved (${r.phoneId})`)
  assert(typeof r.hostUrl === 'string' && r.hostUrl.length > 0, `hostUrl populated (${r.hostUrl})`)

  // Cache the phoneId for subsequent direct-DB-fixture tests
  TEST_PHONE_ID = r.phoneId

  // Release so we don't carry into other tests
  await release(db, convId)
}

async function testInvalidDuration() {
  console.log('\n--- invalid duration ---')
  const convId = await makeConversation()
  for (const dur of [0, -5, 1.5, NaN]) {
    let caught: any = null
    try {
      await acquire(db, { accountId: TEST_ACCOUNT, conversationId: convId, durationMin: dur as any })
    } catch (e: any) { caught = e }
    assert(caught instanceof InvalidDurationError,
      `durationMin=${dur} throws InvalidDurationError (got ${caught?.constructor?.name})`)
  }
}

async function testIdempotentSameConversation() {
  console.log('\n--- idempotent: same conversation re-acquire ---')
  const convId = await makeConversation()
  const first = await acquire(db, { accountId: TEST_ACCOUNT, conversationId: convId, durationMin: 10 })

  const rowsBefore = await db.execute(sql`
    SELECT count(*)::int AS c FROM phone_allocations WHERE conversation_id = ${convId}
  `)
  const cBefore = ((rowsBefore as any).rows?.[0] ?? (rowsBefore as any)[0]).c

  const second = await acquire(db, { accountId: TEST_ACCOUNT, conversationId: convId, durationMin: 15 })
  const rowsAfter = await db.execute(sql`
    SELECT count(*)::int AS c FROM phone_allocations WHERE conversation_id = ${convId}
  `)
  const cAfter = ((rowsAfter as any).rows?.[0] ?? (rowsAfter as any)[0]).c

  assert(cAfter === cBefore, `no new row inserted (rows: ${cBefore} → ${cAfter})`)
  assert(second.allocationId === first.allocationId, 'returns existing allocationId')
  assert(second.expiresAt.getTime() === first.expiresAt.getTime(), 'expiresAt unchanged (no extend)')

  await release(db, convId)
}

async function testMutualExclusion() {
  console.log('\n--- mutual exclusion: PHONE_BUSY ---')
  const holder = await makeConversation()
  const contender = await makeConversation()

  await acquire(db, { accountId: TEST_ACCOUNT, conversationId: holder, durationMin: 10 })

  let caught: any = null
  try {
    await acquire(db, { accountId: TEST_ACCOUNT, conversationId: contender, durationMin: 10 })
  } catch (e: any) { caught = e }
  assert(caught !== null, 'second conversation acquire throws')
  assert(caught instanceof PhoneBusyError, `error is PhoneBusyError (got ${caught?.constructor?.name})`)

  await release(db, holder)
}

async function testReleaseFreesPhone() {
  console.log('\n--- release frees the phone ---')
  const c1 = await makeConversation()
  const c2 = await makeConversation()

  const a1 = await acquire(db, { accountId: TEST_ACCOUNT, conversationId: c1, durationMin: 10 })
  const releaseResult = await release(db, c1)
  assert(releaseResult.released === true, `release returned released=true (got ${releaseResult.released})`)

  const a2 = await acquire(db, { accountId: TEST_ACCOUNT, conversationId: c2, durationMin: 10 })
  assert(a2.allocationId !== a1.allocationId,
    `second conversation got fresh allocation (id ${a2.allocationId} != ${a1.allocationId})`)

  await release(db, c2)
}

async function testReleaseIsTheOnlyUpdate() {
  console.log('\n--- release UPDATEs expires_at on the holder row (no DELETE) ---')
  const conv = await makeConversation()
  const r = await acquire(db, { accountId: TEST_ACCOUNT, conversationId: conv, durationMin: 10 })

  await release(db, conv)

  const rows = await db.execute(sql`
    SELECT id, expires_at FROM phone_allocations WHERE id = ${r.allocationId}
  `)
  const row = (rows as any).rows?.[0] ?? (rows as any)[0]
  assert(row !== undefined, 'row still exists (append-only — no DELETE)')
  if (row) {
    const expiresAt = new Date(row.expires_at).getTime()
    assert(expiresAt <= Date.now() + 1000, `expires_at is now (${new Date(expiresAt).toISOString()})`)
  }
}

async function testReleaseIdempotent() {
  console.log('\n--- release idempotent ---')
  const conv = await makeConversation()
  await acquire(db, { accountId: TEST_ACCOUNT, conversationId: conv, durationMin: 10 })

  const first = await release(db, conv)
  assert(first.released === true, `first release returned released=true (got ${first.released})`)

  let err: any = null
  let second: any = null
  try {
    second = await release(db, conv)
  } catch (e: any) { err = e }
  assert(err === null, 'second release does not throw')
  assert(second?.released === false, `second release returned released=false (got ${second?.released})`)
}

async function testReleaseOfNonExistent() {
  console.log('\n--- release of conversation with no allocation ---')
  const conv = await makeConversation()
  let err: any = null
  let result: any = null
  try {
    result = await release(db, conv)
  } catch (e: any) { err = e }
  assert(err === null, 'release on non-existent allocation does not throw')
  assert(result?.released === false, `released=false on non-existent (got ${result?.released})`)
}

async function testExpiredLeaseFreesPhone() {
  console.log('\n--- expired lease auto-frees ---')
  const stale = await makeConversation()
  const fresh = await makeConversation()

  // Manually insert an already-expired row for `stale` using the previously
  // resolved phone_id. Skip if we don't yet know it (run order dependency).
  if (!TEST_PHONE_ID) {
    // Force resolution with a throwaway acquire+release
    const seed = await makeConversation()
    const r = await acquire(db, { accountId: TEST_ACCOUNT, conversationId: seed, durationMin: 1 })
    TEST_PHONE_ID = r.phoneId
    await release(db, seed)
  }
  await expiringInsert(stale, 60, -10)

  let err: any = null
  try {
    await acquire(db, { accountId: TEST_ACCOUNT, conversationId: fresh, durationMin: 10 })
  } catch (e: any) { err = e }
  assert(err === null, `fresh acquire succeeds when prior lease expired (err: ${err?.message})`)

  await release(db, fresh)
}

async function testSameConvAfterRelease() {
  console.log('\n--- same conversation re-acquire after release = fresh row ---')
  const conv = await makeConversation()
  const a1 = await acquire(db, { accountId: TEST_ACCOUNT, conversationId: conv, durationMin: 10 })
  await release(db, conv)

  const a2 = await acquire(db, { accountId: TEST_ACCOUNT, conversationId: conv, durationMin: 10 })
  assert(a2.allocationId !== a1.allocationId, `fresh row inserted (id ${a2.allocationId} != ${a1.allocationId})`)
  assert(a2.expiresAt.getTime() > Date.now() + 590_000, 'fresh expires_at far in future')

  await release(db, conv)
}

async function testGetActiveLatestNonExpired() {
  console.log('\n--- getActive returns latest non-expired row ---')
  const conv = await makeConversation()

  // Older expired rows
  await expiringInsert(conv, 600, -300)
  await expiringInsert(conv, 100, -1)
  // Fresh active row
  const active = await acquire(db, { accountId: TEST_ACCOUNT, conversationId: conv, durationMin: 10 })

  const r = await getActive(db, conv)
  assert(r !== null, 'getActive returns a row')
  assert(r?.allocationId === active.allocationId,
    `returns active row (got ${r?.allocationId}, expected ${active.allocationId})`)

  await release(db, conv)
}

async function testGetActiveAllExpired() {
  console.log('\n--- getActive returns null when all expired ---')
  const conv = await makeConversation()
  if (!TEST_PHONE_ID) {
    const seed = await makeConversation()
    const r = await acquire(db, { accountId: TEST_ACCOUNT, conversationId: seed, durationMin: 1 })
    TEST_PHONE_ID = r.phoneId
    await release(db, seed)
  }
  await expiringInsert(conv, 100, -10)

  const r = await getActive(db, conv)
  assert(r === null, `getActive returns null (got ${JSON.stringify(r)})`)
}

async function testGetActiveNoRows() {
  console.log('\n--- getActive returns null when no rows ---')
  const conv = await makeConversation()
  const r = await getActive(db, conv)
  assert(r === null, 'getActive on conv with no allocations returns null')
}

async function main() {
  console.log('=== Allocation Service Tests ===')
  console.log(`  test account: ${TEST_ACCOUNT}`)

  try {
    await testAcquireHappy()                  // resolves TEST_PHONE_ID for later tests
    await testInvalidDuration()
    await testIdempotentSameConversation()
    await testMutualExclusion()
    await testReleaseFreesPhone()
    await testReleaseIsTheOnlyUpdate()
    await testReleaseIdempotent()
    await testReleaseOfNonExistent()
    await testExpiredLeaseFreesPhone()
    await testSameConvAfterRelease()
    await testGetActiveLatestNonExpired()
    await testGetActiveAllExpired()
    await testGetActiveNoRows()
  } finally {
    await cleanup()
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  cleanup().finally(() => process.exit(1))
})
