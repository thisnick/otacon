/**
 * `POST /api/v1/runs/:id/cancel` — request a cooperative cancel.
 *
 * Body: `{reason?: string}` (optional human-readable note).
 *
 * Resolves the run's `cancelHook` (token format `cancel:${runId}`)
 * which the workflow body races against `agent.stream(...)` at every
 * turn boundary. When the hook resolves, the body breaks the loop,
 * runs `markRunStatusStep('cancelled')` + `emitRunCancelledStep`, and
 * returns cleanly — so the SSE `/stream` consumer always sees a
 * `data-run-cancelled` terminal chunk.
 *
 * Cancellation latency is bounded by one agent turn (model + tools).
 * That's finite — the prior implementation called `wfRun.cancel()`
 * directly which interrupted the body before it could emit any
 * terminal chunk, leaving SSE clients waiting forever (P3-E feedback).
 *
 * Idempotent: cancelling a run that's already terminal returns the
 * current state without touching the hook (resolving an
 * already-resolved hook would throw).
 *
 * Edge cases:
 *   - run.workflowRunId not set → never started, mark cancelled
 *     directly + return (no body to signal).
 *   - resumeHook throws (hook not registered yet, or already resolved
 *     via a prior call) → fall back to direct `wfRun.cancel()` +
 *     RunStore update so the route still produces a sane terminal
 *     state from the run.json side. The SSE stream won't get a
 *     terminal chunk in that fallback path; that's a known gap on
 *     the rare "double cancel" or "cancel during workflow init" race.
 */
import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import { getRun, resumeHook } from 'workflow/api'
import { z } from 'zod'
import { makeStores } from '../../../../../../src/storage/factory.js'
import { cancelToken } from '../../../../../../src/run-executor/approval-bridge.js'

const Body = z.object({
  reason: z.string().optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id', { decode: true })
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'missing run id' })
  }
  const raw = await readBody(event).catch(() => ({}))
  const parsed = Body.safeParse(raw ?? {})
  const reason =
    parsed.success && parsed.data.reason ? parsed.data.reason : 'cancel requested via API'

  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { runStore } = await makeStores({ dataDir })
  const run = await runStore.get(id)
  if (!run) {
    throw createError({ statusCode: 404, statusMessage: `run ${id} not found` })
  }

  // Already terminal — nothing to do.
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return { run }
  }

  if (!run.workflowRunId) {
    // Run was created but never started — no workflow body to signal.
    const updated = await runStore.updateStatus(id, 'cancelled', {
      error: 'cancelled before workflow start',
    })
    return { run: updated }
  }

  // Cooperative cancel: resolve the cancelHook the workflow body
  // registered at start. Body races this against agent.stream(...)
  // and emits data-run-cancelled cleanly when it resolves.
  try {
    await resumeHook(cancelToken(id), { reason })
    // Don't update RunStore here — the workflow body's
    // markRunStatusStep('cancelled') will fire when it picks up the
    // cancel signal and runs emitRunCancelledStep. Returning the
    // current run.json (still 'running') is correct: the cancellation
    // is in-flight and the next /runs/:id read will reflect it once
    // the body lands its update.
    return { run, cancelling: true }
  } catch (err) {
    // Hook not registered (workflow body crashed before reaching
    // create() OR cancel was already resolved). Fall back to a hard
    // cancel + RunStore patch so the run state is at least sane.
    const wfRun = getRun<unknown>(run.workflowRunId)
    const exists = await wfRun.exists
    if (exists) {
      try {
        await wfRun.cancel()
      } catch {
        /* swallow — best-effort */
      }
    }
    const updated = await runStore.updateStatus(id, 'cancelled', {
      error: `cooperative cancel failed (${(err as Error).message}); fell back to direct cancel`,
    })
    return { run: updated, fallback: true }
  }
})
