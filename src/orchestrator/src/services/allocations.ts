/**
 * Phone allocation service: acquire/release/getActive against the
 * phone_allocations table. Append-only by default; the only UPDATE is
 * explicit early release setting expires_at = now().
 *
 * Dual-ID note: the `phone_allocations.phone_id` column stores the registry
 * phone ID (e.g. "phone-4") — that's the durable, cross-host identity used
 * for mutual exclusion. The OtaconClient URL is built from `localPhoneId`
 * (e.g. "phone-r5ct60sd") which the host serves under /phones/<id>. Never
 * confuse the two.
 */
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Db } from '../db/client.js'
import { resolvePhone } from '../resolve/phone.js'
import { accountCredentials } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'

export class PhoneBusyError extends Error {
  code = 'PHONE_BUSY' as const
  constructor(public phoneId: string) {
    super(`phone ${phoneId} is held by another conversation`)
  }
}

export class InvalidDurationError extends Error {
  code = 'INVALID_DURATION' as const
  constructor(msg = 'duration must be a positive integer (minutes)') {
    super(msg)
  }
}

export interface ResolvedAccountPhone {
  /** Registry phone ID (e.g. "phone-4"). Stored in DB for mutual exclusion. */
  phoneId: string
  /** Host-local phone ID (e.g. "phone-r5ct60sd") — what goes in URLs. */
  localPhoneId: string
  /** Host base URL: https://fqdn:port (no /phones suffix). */
  hostUrl: string
  /** Pre-built OtaconClient base URL: ${hostUrl}/phones/${localPhoneId}. */
  clientBaseUrl: string
}

export interface ActiveAllocation {
  allocationId: string
  phoneId: string
  localPhoneId: string
  hostUrl: string
  clientBaseUrl: string
  expiresAt: Date
}

export interface AcquireResult extends ActiveAllocation {}

/**
 * Look up the account's primary phone credential, then resolve to a
 * registry phone id, host-local phone id, and host base URL.
 */
async function resolveAccountPhone(db: Db, accountId: string): Promise<ResolvedAccountPhone> {
  const [phoneCred] = await db
    .select()
    .from(accountCredentials)
    .where(and(
      eq(accountCredentials.accountId, accountId),
      eq(accountCredentials.credentialType, 'phone'),
    ))
    .limit(1)
  if (!phoneCred) throw new Error(`account "${accountId}" has no phone credential`)
  const resolved = await resolvePhone(phoneCred.identifier)
  return {
    phoneId: resolved.phoneId,
    localPhoneId: resolved.localPhoneId,
    hostUrl: resolved.hostUrl,
    clientBaseUrl: resolved.baseUrl,
  }
}

/**
 * Get the active (non-expired) allocation for a conversation, if any.
 * Returns the latest by allocated_at.
 *
 * Note: `localPhoneId` and `clientBaseUrl` are NOT populated here — they
 * require a fresh registry lookup, which is expensive. Callers that need
 * them (e.g. rebuilding the sandbox cache) should re-resolve via
 * `resolvePhoneForAccount`. The orchestrator-internal getActive callers
 * who only check expiry/identity skip the resolve.
 */
export async function getActive(db: Db, conversationId: string): Promise<{
  allocationId: string
  phoneId: string
  expiresAt: Date
} | null> {
  const rows = await db.execute(sql`
    SELECT id, phone_id, expires_at
    FROM phone_allocations
    WHERE conversation_id = ${conversationId}
      AND expires_at > now()
    ORDER BY allocated_at DESC
    LIMIT 1
  `)
  const row = (rows as any).rows?.[0] ?? (rows as any)[0]
  if (!row) return null

  return {
    allocationId: row.id,
    phoneId: row.phone_id,
    expiresAt: new Date(row.expires_at),
  }
}

/**
 * Idempotent provision. If the conversation already holds an active lease,
 * returns it without inserting. Otherwise inserts a new row with mutual
 * exclusion against other conversations holding the same phone.
 *
 * Throws PhoneBusyError if another conversation has an active lease.
 * Throws InvalidDurationError for non-positive durations.
 */
export async function acquire(
  db: Db,
  opts: { accountId: string; conversationId: string; durationMin: number },
): Promise<AcquireResult> {
  const { accountId, conversationId, durationMin } = opts

  if (!Number.isFinite(durationMin) || durationMin <= 0 || !Number.isInteger(durationMin)) {
    throw new InvalidDurationError()
  }

  // Resolve the phone first — we need phoneId (registry) for the DB row,
  // and localPhoneId/clientBaseUrl for the OtaconClient URL.
  const resolved = await resolveAccountPhone(db, accountId)
  const { phoneId, localPhoneId, hostUrl, clientBaseUrl } = resolved

  // 1) Idempotent: do we already hold an active lease for this conversation/phone?
  const existing = await db.execute(sql`
    SELECT id, expires_at
    FROM phone_allocations
    WHERE conversation_id = ${conversationId}
      AND phone_id = ${phoneId}
      AND expires_at > now()
    ORDER BY allocated_at DESC
    LIMIT 1
  `)
  const existingRow = (existing as any).rows?.[0] ?? (existing as any)[0]
  if (existingRow) {
    return {
      allocationId: existingRow.id,
      phoneId,
      localPhoneId,
      hostUrl,
      clientBaseUrl,
      expiresAt: new Date(existingRow.expires_at),
    }
  }

  // 2) Mutual exclusion + INSERT in a single batch (neon http batch = 1 tx).
  // Lock on a hash of phone_id, then INSERT only if no other conversation
  // currently holds an active lease for this phone.
  const id = ulid()
  const result = await db.batch([
    db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${phoneId}))`),
    db.execute(sql`
      INSERT INTO phone_allocations (id, phone_id, conversation_id, allocated_at, expires_at)
      SELECT ${id}, ${phoneId}, ${conversationId}, now(), now() + (${durationMin} * interval '1 minute')
      WHERE NOT EXISTS (
        SELECT 1 FROM (
          SELECT DISTINCT ON (conversation_id) conversation_id, expires_at
          FROM phone_allocations
          WHERE phone_id = ${phoneId} AND conversation_id != ${conversationId}
          ORDER BY conversation_id, allocated_at DESC
        ) latest
        WHERE expires_at > now()
      )
      RETURNING id, expires_at
    `),
  ])

  const insertResult = result[1] as any
  const inserted = insertResult.rows?.[0] ?? insertResult[0]

  if (!inserted) {
    throw new PhoneBusyError(phoneId)
  }

  return {
    allocationId: inserted.id,
    phoneId,
    localPhoneId,
    hostUrl,
    clientBaseUrl,
    expiresAt: new Date(inserted.expires_at),
  }
}

/**
 * Idempotent release. Updates expires_at = now() on the conversation's latest
 * non-expired row. No-op if no active row.
 */
export async function release(db: Db, conversationId: string): Promise<{ released: boolean }> {
  const result = await db.execute(sql`
    UPDATE phone_allocations
    SET expires_at = now()
    WHERE id = (
      SELECT id FROM phone_allocations
      WHERE conversation_id = ${conversationId}
        AND expires_at > now()
      ORDER BY allocated_at DESC
      LIMIT 1
    )
    RETURNING id
  `)
  const rows = (result as any).rows ?? (result as any)
  return { released: Array.isArray(rows) ? rows.length > 0 : false }
}

/**
 * Resolve the account's phone (registry id + local id + host URL).
 * Used by the sandbox to rebuild AllocationContext on cold start.
 */
export async function resolvePhoneForAccount(db: Db, accountId: string): Promise<ResolvedAccountPhone> {
  return resolveAccountPhone(db, accountId)
}
