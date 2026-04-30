/**
 * `otacon-alloc` defineCommand — FS-backed (orchestrator-v2 path).
 *
 * Same interface as `alloc-commands.ts` (the legacy DB-backed version)
 * — provision, release, status — but operates against
 * `AllocationStore` (FS-backed JSON file at
 * `${ORCHESTRATOR_DATA_DIR}/allocations.json`) instead of Drizzle.
 *
 * The legacy file stays in place until commit 10 deletes it.
 */
import type { AllocationContext } from './allocation-context.js'
import type { AllocationStore } from '../storage/allocation-store.js'

export interface AllocCommandSpec {
  name: string
  description: string
  usage: string
  examples: string[]
  /** Returns stdout text. Throws to indicate failure. */
  run(args: string[]): Promise<string>
}

export interface AllocCommandsContextFs {
  allocationStore: AllocationStore
  accountId: string
  /** runId substitutes for the legacy conversationId. */
  runId: string
  allocCtx: AllocationContext
}

const DEFAULT_DURATION_MIN = 10

export function buildAllocRegistryFs(
  ctx: AllocCommandsContextFs,
): Record<string, AllocCommandSpec> {
  const provision: AllocCommandSpec = {
    name: 'provision',
    description:
      'Acquire a phone allocation (lease) for this run. Idempotent — calling twice while a lease is active returns the existing expires_at.',
    usage: 'otacon-alloc provision [duration_minutes=10]',
    examples: ['otacon-alloc provision', 'otacon-alloc provision 15'],
    async run(args) {
      let duration = DEFAULT_DURATION_MIN
      if (args[0]) {
        const parsed = parseInt(args[0], 10)
        if (Number.isNaN(parsed) || parsed <= 0) {
          throw new Error('INVALID_DURATION: duration must be a positive integer (minutes)')
        }
        duration = parsed
      }
      try {
        const result = await ctx.allocationStore.acquire({
          accountId: ctx.accountId,
          runId: ctx.runId,
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
        const remaining = Math.max(
          0,
          Math.floor((result.expiresAt.getTime() - Date.now()) / 1000),
        )
        return JSON.stringify(
          {
            ok: true,
            allocation_id: result.allocationId,
            expires_at: result.expiresAt.toISOString(),
            time_remaining_seconds: remaining,
          },
          null,
          2,
        )
      } catch (e: unknown) {
        const err = e as { code?: string; message?: string }
        if (err?.code === 'PHONE_BUSY') {
          throw new Error('PHONE_BUSY: another run holds an active lease on this phone')
        }
        if (err?.code === 'INVALID_DURATION') {
          throw new Error(`INVALID_DURATION: ${err.message}`)
        }
        throw e
      }
    },
  }

  const release: AllocCommandSpec = {
    name: 'release',
    description:
      'Release the current allocation early so another run can acquire it. Idempotent.',
    usage: 'otacon-alloc release',
    examples: ['otacon-alloc release'],
    async run() {
      const result = await ctx.allocationStore.release(ctx.runId)
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
        const fromFile = await ctx.allocationStore.getActive(ctx.runId)
        if (fromFile) {
          try {
            const resolved = await ctx.allocationStore.resolvePhoneForAccount(ctx.accountId)
            ctx.allocCtx.set({
              allocationId: fromFile.allocationId,
              phoneId: fromFile.phoneId,
              localPhoneId: resolved.localPhoneId,
              hostUrl: resolved.hostUrl,
              clientBaseUrl: resolved.clientBaseUrl,
              expiresAt: fromFile.expiresAt,
            })
            const remaining = Math.max(
              0,
              Math.floor((fromFile.expiresAt.getTime() - Date.now()) / 1000),
            )
            return JSON.stringify(
              {
                has_allocation: true,
                allocation_id: fromFile.allocationId,
                expires_at: fromFile.expiresAt.toISOString(),
                time_remaining_seconds: remaining,
              },
              null,
              2,
            )
          } catch {
            // fall through
          }
        }
        return JSON.stringify(
          { has_allocation: false, expires_at: null, time_remaining_seconds: 0 },
          null,
          2,
        )
      }
      const remaining = Math.max(
        0,
        Math.floor((active.expiresAt.getTime() - Date.now()) / 1000),
      )
      return JSON.stringify(
        {
          has_allocation: true,
          allocation_id: active.allocationId,
          expires_at: active.expiresAt.toISOString(),
          time_remaining_seconds: remaining,
        },
        null,
        2,
      )
    },
  }

  return { provision, release, status }
}
