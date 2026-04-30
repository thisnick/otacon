/**
 * AllocationStore — FS-backed phone-allocation tracking.
 *
 * Replaces the Drizzle `phone_allocations` table for the orchestrator-v2
 * pipeline. The legacy DB-backed service (`src/services/allocations.ts`)
 * stays in place for the legacy `agent run` path until commit 10
 * deletes it.
 *
 * On disk: `${ORCHESTRATOR_DATA_DIR}/allocations.json`. A single JSON
 * file with all rows (a `runId` is the new "conversationId" per
 * commit-7b's bridge — see sandbox-cache.ts). Allocations expire on a
 * timestamp; we filter at read time, so writes don't need to clean up
 * stale rows.
 *
 * Concurrency:
 * - Single-process safety via an in-process async mutex per file.
 * - Multi-process safety via atomic-rename writes (write to
 *   `<file>.tmp.<pid>` then rename). Two processes racing to acquire
 *   the same phone could see a momentary inconsistent state, but since
 *   phone-3 is the only e2e target and we're single-process Nitro for
 *   P1, that risk doesn't materialize. If a future deployment needs
 *   strict cross-process safety we add `proper-lockfile`.
 *
 * The store carries the same shape as the legacy service:
 *   acquire / release / getActive / resolvePhoneForAccount.
 *
 * Tests live in `tests/orchestrator/unit/test-storage.ts`.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ulid } from 'ulid'
import type { PathLayout } from './paths.js'
import type { AllocationRow, AllocationsFile } from './types.js'
import type { AccountStore } from './account-store.js'

export class PhoneBusyError extends Error {
  code = 'PHONE_BUSY' as const
  constructor(public phoneId: string) {
    super(`phone ${phoneId} is held by another run`)
  }
}

export class InvalidDurationError extends Error {
  code = 'INVALID_DURATION' as const
  constructor(msg = 'duration must be a positive integer (minutes)') {
    super(msg)
  }
}

export interface ResolvedPhone {
  /** Registry phone ID (e.g. "phone-4"). For DB pairing / mutual exclusion. */
  phoneId: string
  /** Host-local phone ID (e.g. "phone-r5ct60sd"). USE THIS in URLs. */
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

export interface AllocationStore {
  acquire(opts: {
    accountId: string
    runId: string
    durationMin: number
  }): Promise<ActiveAllocation>
  release(runId: string): Promise<{ released: boolean }>
  getActive(runId: string): Promise<{
    allocationId: string
    phoneId: string
    expiresAt: Date
  } | null>
  resolvePhoneForAccount(accountId: string): Promise<ResolvedPhone>
}

export interface AllocationStoreFsOpts {
  layout: PathLayout
  accountStore: AccountStore
  /**
   * Resolve a phone-number credential to a registry phone + host URL.
   * Injected so this module doesn't pull in `src/resolve/phone.ts`
   * directly — keeps unit tests hermetic.
   */
  resolvePhone: (phoneNumber: string) => Promise<{
    phoneId: string
    localPhoneId: string
    hostUrl: string
    baseUrl: string
  }>
}

export class AllocationStoreFs implements AllocationStore {
  private mutex: Promise<unknown> = Promise.resolve()

  constructor(private opts: AllocationStoreFsOpts) {}

  /** Serialize file mutations through an in-process mutex. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex
    let release: () => void = () => {}
    this.mutex = new Promise<void>((resolve) => { release = resolve })
    try {
      await prev
      return await fn()
    } finally {
      release()
    }
  }

  private async readFile(): Promise<AllocationsFile> {
    try {
      const raw = await fs.readFile(this.opts.layout.allocationsFile, 'utf-8')
      const parsed = JSON.parse(raw) as AllocationsFile
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.rows)) {
        return { version: 1, rows: [] }
      }
      return parsed
    } catch (e: any) {
      if (e?.code === 'ENOENT') return { version: 1, rows: [] }
      throw e
    }
  }

  /** Atomic write via temp file + rename. */
  private async writeFile(file: AllocationsFile): Promise<void> {
    const target = this.opts.layout.allocationsFile
    await fs.mkdir(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8')
    await fs.rename(tmp, target)
  }

  async resolvePhoneForAccount(accountId: string): Promise<ResolvedPhone> {
    const cred = await this.opts.accountStore.primaryCredential(accountId, 'phone')
    if (!cred) {
      throw new Error(`account "${accountId}" has no phone credential`)
    }
    const resolved = await this.opts.resolvePhone(cred.identifier)
    return {
      phoneId: resolved.phoneId,
      localPhoneId: resolved.localPhoneId,
      hostUrl: resolved.hostUrl,
      clientBaseUrl: resolved.baseUrl,
    }
  }

  async getActive(runId: string): Promise<{
    allocationId: string
    phoneId: string
    expiresAt: Date
  } | null> {
    const file = await this.readFile()
    const now = Date.now()
    const active = file.rows
      .filter(r => r.conversationId === runId && r.expiresAt > now)
      .sort((a, b) => b.allocatedAt - a.allocatedAt)[0]
    if (!active) return null
    return {
      allocationId: active.allocationId,
      phoneId: active.phoneId,
      expiresAt: new Date(active.expiresAt),
    }
  }

  /**
   * Idempotent provision. If the run already holds an active lease,
   * returns it without inserting. Otherwise inserts a new row with
   * mutual exclusion against other runs holding the same phone.
   */
  async acquire(opts: {
    accountId: string
    runId: string
    durationMin: number
  }): Promise<ActiveAllocation> {
    if (
      !Number.isFinite(opts.durationMin) ||
      opts.durationMin <= 0 ||
      !Number.isInteger(opts.durationMin)
    ) {
      throw new InvalidDurationError()
    }
    const resolved = await this.resolvePhoneForAccount(opts.accountId)
    return await this.withLock(async () => {
      const file = await this.readFile()
      const now = Date.now()

      // Idempotent return for an existing active lease on this run.
      const existing = file.rows
        .filter(
          r =>
            r.conversationId === opts.runId &&
            r.phoneId === resolved.phoneId &&
            r.expiresAt > now,
        )
        .sort((a, b) => b.allocatedAt - a.allocatedAt)[0]
      if (existing) {
        return {
          allocationId: existing.allocationId,
          phoneId: existing.phoneId,
          localPhoneId: resolved.localPhoneId,
          hostUrl: resolved.hostUrl,
          clientBaseUrl: resolved.clientBaseUrl,
          expiresAt: new Date(existing.expiresAt),
        }
      }

      // Mutual exclusion: any OTHER run holding this phone with active
      // lease blocks us.
      const conflict = file.rows.find(
        r =>
          r.phoneId === resolved.phoneId &&
          r.conversationId !== opts.runId &&
          r.expiresAt > now,
      )
      if (conflict) throw new PhoneBusyError(resolved.phoneId)

      const row: AllocationRow = {
        allocationId: ulid(),
        phoneId: resolved.phoneId,
        conversationId: opts.runId,
        allocatedAt: now,
        expiresAt: now + opts.durationMin * 60_000,
      }
      const next: AllocationsFile = {
        version: 1,
        // Compact: drop expired-and-released rows older than 24h.
        rows: [
          ...file.rows.filter(r => r.expiresAt > now - 24 * 60 * 60_000),
          row,
        ],
      }
      await this.writeFile(next)

      return {
        allocationId: row.allocationId,
        phoneId: row.phoneId,
        localPhoneId: resolved.localPhoneId,
        hostUrl: resolved.hostUrl,
        clientBaseUrl: resolved.clientBaseUrl,
        expiresAt: new Date(row.expiresAt),
      }
    })
  }

  /**
   * Idempotent release — sets the latest non-expired row's expiresAt to
   * now (frees the phone immediately). No-op if no active row.
   */
  async release(runId: string): Promise<{ released: boolean }> {
    return await this.withLock(async () => {
      const file = await this.readFile()
      const now = Date.now()
      const idx = file.rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.conversationId === runId && r.expiresAt > now)
        .sort((a, b) => b.r.allocatedAt - a.r.allocatedAt)[0]?.i
      if (idx === undefined) return { released: false }
      const next: AllocationsFile = {
        version: 1,
        rows: file.rows.map((r, i) => (i === idx ? { ...r, expiresAt: now } : r)),
      }
      await this.writeFile(next)
      return { released: true }
    })
  }
}
