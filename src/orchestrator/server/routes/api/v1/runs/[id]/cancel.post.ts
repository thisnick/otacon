/**
 * `POST /api/v1/runs/:id/cancel` — cancel a running workflow.
 *
 * Calls `wfRun.cancel()` (Workflow SDK), then writes RunStore status to
 * `cancelled` so list scans + GET /runs/:id reflect the change. The
 * workflow's own `markRunStatusStep('cancelled')` doesn't fire because
 * the workflow body is interrupted before it finishes — so the route
 * has to update the index itself.
 *
 * Idempotent: cancelling an already-completed/cancelled/failed run is a
 * no-op (Workflow SDK's cancel is itself idempotent; we then ensure
 * RunStore reflects a terminal state).
 *
 * Returns `{run: Run}` with the updated metadata.
 */
import { defineEventHandler, getRouterParam, createError } from 'h3'
import { getRun } from 'workflow/api'
import { makeStores } from '../../../../../../src/storage/factory.js'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'missing run id' })
  }

  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { runStore } = await makeStores({ dataDir })
  const run = await runStore.get(id)
  if (!run) {
    throw createError({ statusCode: 404, statusMessage: `run ${id} not found` })
  }

  // Already terminal — nothing to do, just echo back current state.
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return { run }
  }

  if (!run.workflowRunId) {
    // Run was created but never started (no workflowRunId assigned).
    // Treat as cancellation by marking status; nothing to ask the SDK.
    const updated = await runStore.updateStatus(id, 'cancelled', {
      error: 'cancelled before workflow start',
    })
    return { run: updated }
  }

  const wfRun = getRun<unknown>(run.workflowRunId)
  const exists = await wfRun.exists
  if (exists) {
    await wfRun.cancel()
  }
  // Always patch our metadata to cancelled regardless — the SDK call
  // is best-effort, but our index must agree.
  const updated = await runStore.updateStatus(id, 'cancelled')
  return { run: updated }
})
