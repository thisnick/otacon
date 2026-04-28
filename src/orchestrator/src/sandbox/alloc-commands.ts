/**
 * `otacon-alloc` defineCommand: provision / release / status.
 *
 * Operates on AllocationContext (in-memory) + services/allocations.ts (DB).
 * Idempotent provision: same conversation calling provision twice while still
 * holding lease is a no-op.
 */
import type { Db } from '../db/client.js'
import type { AllocationContext } from './allocation-context.js'
import * as allocSvc from '../services/allocations.js'

export interface AllocCommandSpec {
  name: string
  description: string
  usage: string
  examples: string[]
  /** Returns stdout text. Throws to indicate failure. */
  run(args: string[]): Promise<string>
}

export interface AllocCommandsContext {
  db: Db
  accountId: string
  conversationId: string
  allocCtx: AllocationContext
}

const DEFAULT_DURATION_MIN = 10

export function buildAllocRegistry(ctx: AllocCommandsContext): Record<string, AllocCommandSpec> {
  const provision: AllocCommandSpec = {
    name: 'provision',
    description:
      'Acquire a phone allocation (lease) for this conversation. Idempotent — calling twice while a lease is active returns the existing expires_at.',
    usage: 'otacon-alloc provision [duration_minutes=10]',
    examples: ['otacon-alloc provision', 'otacon-alloc provision 15'],
    async run(args) {
      let duration = DEFAULT_DURATION_MIN
      if (args[0]) {
        const parsed = parseInt(args[0], 10)
        if (isNaN(parsed) || parsed <= 0) {
          throw new Error('INVALID_DURATION: duration must be a positive integer (minutes)')
        }
        duration = parsed
      }

      try {
        const result = await allocSvc.acquire(ctx.db, {
          accountId: ctx.accountId,
          conversationId: ctx.conversationId,
          durationMin: duration,
        })
        ctx.allocCtx.set({
          allocationId: result.allocationId,
          phoneId: result.phoneId,
          localPhoneId: result.localPhoneId,
          hostUrl: result.hostUrl,
          clientBaseUrl: result.clientBaseUrl,
          expiresAt: result.expiresAt,
        })
        const remaining = Math.max(0, Math.floor((result.expiresAt.getTime() - Date.now()) / 1000))
        return JSON.stringify({
          ok: true,
          allocation_id: result.allocationId,
          expires_at: result.expiresAt.toISOString(),
          time_remaining_seconds: remaining,
        }, null, 2)
      } catch (e: any) {
        if (e?.code === 'PHONE_BUSY') {
          throw new Error('PHONE_BUSY: another conversation holds an active lease on this phone')
        }
        if (e?.code === 'INVALID_DURATION') {
          throw new Error(`INVALID_DURATION: ${e.message}`)
        }
        throw e
      }
    },
  }

  const release: AllocCommandSpec = {
    name: 'release',
    description:
      'Release the current allocation early so another conversation can acquire it. Idempotent.',
    usage: 'otacon-alloc release',
    examples: ['otacon-alloc release'],
    async run() {
      const result = await allocSvc.release(ctx.db, ctx.conversationId)
      ctx.allocCtx.clear()
      return JSON.stringify({ ok: true, released: result.released }, null, 2)
    },
  }

  const status: AllocCommandSpec = {
    name: 'status',
    description:
      'Show the current allocation. Returns has_allocation, expires_at, time_remaining_seconds.',
    usage: 'otacon-alloc status',
    examples: ['otacon-alloc status'],
    async run() {
      const active = ctx.allocCtx.get()
      if (!active) {
        // Try to rebuild from DB on cache miss (e.g., post-restart)
        const fromDb = await allocSvc.getActive(ctx.db, ctx.conversationId)
        if (fromDb) {
          // We need a hostUrl to fully populate the cache for `otacon` dispatch.
          // getActive returns hostUrl='' — re-resolve via account credential.
          try {
            const resolved = await allocSvc.resolvePhoneForAccount(ctx.db, ctx.accountId)
            ctx.allocCtx.set({
              allocationId: fromDb.allocationId,
              phoneId: fromDb.phoneId,
              localPhoneId: resolved.localPhoneId,
              hostUrl: resolved.hostUrl,
              clientBaseUrl: resolved.clientBaseUrl,
              expiresAt: fromDb.expiresAt,
            })
            const remaining = Math.max(0, Math.floor((fromDb.expiresAt.getTime() - Date.now()) / 1000))
            return JSON.stringify({
              has_allocation: true,
              allocation_id: fromDb.allocationId,
              expires_at: fromDb.expiresAt.toISOString(),
              time_remaining_seconds: remaining,
            }, null, 2)
          } catch {
            // Fall through to "no allocation"
          }
        }
        return JSON.stringify({
          has_allocation: false,
          expires_at: null,
          time_remaining_seconds: 0,
        }, null, 2)
      }
      const remaining = Math.max(0, Math.floor((active.expiresAt.getTime() - Date.now()) / 1000))
      return JSON.stringify({
        has_allocation: true,
        allocation_id: active.allocationId,
        expires_at: active.expiresAt.toISOString(),
        time_remaining_seconds: remaining,
      }, null, 2)
    },
  }

  return { provision, release, status }
}
