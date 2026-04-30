/**
 * Approval bridge: typed hook definitions for human-in-the-loop approval
 * + escalation, plus a helper that persists signal metadata to the
 * SignalStore so the UI/CLI can list pending approvals without traversing
 * Workflow SDK internals.
 *
 * Architecture (from workflow/docs/ai/human-in-the-loop):
 *   1. Tool's `execute` function (no `'use step'`) calls
 *      `<approvalHook>.create({token: toolCallId})` — runs in workflow
 *      context where hooks live.
 *   2. The execute function awaits the hook. The workflow durably
 *      suspends — orchestrator can crash/restart, `world-local` keeps
 *      the suspension state.
 *   3. External resolver calls `approvalHook.resume(token, decision)`
 *      from a step (or HTTP route). Workflow resumes with the payload.
 *
 * The SignalStore write happens in a step so the UI/CLI has a queryable
 * record of pending signals without inspecting workflow internals.
 */
import { defineHook } from 'workflow'
import { z } from 'zod'
import type { SignalStore } from '../storage/signal-store.js'
import type { SignalInput } from '../storage/types.js'

/**
 * Approval decision returned by the human via UI/CLI/webhook.
 *
 * `approve` — proceed with the gated action
 * `reject` — abort this action, agent continues with the next step
 * `skip`   — abort this and the rest of the session (agent should stop)
 */
export const approvalSchema = z.object({
  decision: z.enum(['approve', 'reject', 'skip']),
  message: z.string().optional(),
})

export type ApprovalPayload = z.infer<typeof approvalSchema>

/**
 * Approval gate for mutating phone commands. Token format:
 *   `approval:${runId}:${toolCallId}`
 *
 * The token is fully derivable from `runId` + `toolCallId`, which makes
 * it deterministic — replays of the workflow body produce the same
 * token, and external resolvers can reconstruct it without out-of-band
 * lookups.
 *
 * **Load-bearing ordering inside a tool's `execute` (no `'use step'`):**
 *
 *   1. `approvalHook.create({token})` — registers the token with
 *      `world-local`'s hook index. Synchronous from the workflow's POV;
 *      hook is queryable via `world.hooks.getByToken(token)` immediately
 *      after.
 *   2. Persist a SignalStore record + emit a `data-signal-created`
 *      chunk via a `'use step'` helper. External resolvers read the
 *      chunk over SSE and look up the signal by id.
 *   3. `await hook` — durable suspend. Workflow resumes when an
 *      external caller invokes `resumeHook(token, payload)` (typically
 *      from POST `/api/v1/signals/:id/resolve`).
 *
 * Reversing steps 1 and 2 introduces a race: a fast resolver can POST
 * before `createHook` has run, hitting `HookNotFoundError`. Always
 * register the hook first. References: `workflows/lead-agent.ts`
 * (bash + escalate tools) and `workflows/approval-flow.ts`.
 */
export const approvalHook = defineHook({ schema: approvalSchema })

export const escalationSchema = z.object({
  decision: z.enum(['approve', 'reject', 'skip']),
  message: z.string().optional(),
})

export type EscalationPayload = z.infer<typeof escalationSchema>

/**
 * Escalation hook for the agent's `escalate` tool (asking the human for
 * help/guidance). Token format:
 *   `escalation:${runId}:${toolCallId}`
 */
export const escalationHook = defineHook({ schema: escalationSchema })

export interface PersistSignalOpts {
  signalStore: SignalStore
  runId: string
  toolCallId: string
  kind: 'approval' | 'escalation'
  command?: string
  rationale?: string
  screenshotPath?: string
  payload?: Record<string, unknown>
}

/**
 * Persist a signal record for a pending approval/escalation. The
 * SignalStore record carries the deterministic hook token so the
 * resolve route can look it up.
 *
 * Plain async function — caller is responsible for invoking it from a
 * step (or any context with full Node access). Wrapping it in its own
 * `'use step'` would be redundant since callers always wrap.
 *
 * Idempotent: writes a fresh JSON file at
 * `runs/{runId}/signals/{signalId}.json`. If called twice with the same
 * signalId (which is derived from toolCallId), the second write
 * overwrites the first with the same content.
 */
export async function persistSignal(opts: PersistSignalOpts): Promise<void> {
  const token =
    opts.kind === 'approval'
      ? approvalToken(opts.runId, opts.toolCallId)
      : escalationToken(opts.runId, opts.toolCallId)
  const input: SignalInput = {
    id: signalIdFor(opts.runId, opts.toolCallId, opts.kind),
    runId: opts.runId,
    kind: opts.kind,
    hookToken: token,
    toolCallId: opts.toolCallId,
    command: opts.command ?? null,
    rationale: opts.rationale ?? null,
    screenshotPath: opts.screenshotPath ?? null,
    payload: opts.payload ?? {},
  }
  await opts.signalStore.create(input)
}

export function approvalToken(runId: string, toolCallId: string): string {
  return `approval:${runId}:${toolCallId}`
}

export function escalationToken(runId: string, toolCallId: string): string {
  return `escalation:${runId}:${toolCallId}`
}

/**
 * Stable signal id derived from runId + toolCallId + kind. Lets the
 * UI/CLI fetch a signal by id without scanning, and makes
 * `persistSignal()` idempotent across replays.
 */
export function signalIdFor(
  runId: string,
  toolCallId: string,
  kind: 'approval' | 'escalation',
): string {
  // Replace ':' so it satisfies assertSafeId — keep the rest readable.
  return `${kind}-${runId}-${toolCallId}`.replace(/[^A-Za-z0-9._:+-]/g, '_')
}
