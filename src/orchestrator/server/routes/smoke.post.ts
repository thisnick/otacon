/**
 * Smoke route — verifies the Nitro + workflow/nitro + world-local pipeline.
 *
 * POST /smoke         — kicks off the smoke workflow
 *                       Body: {message?: string, ticks?: number}
 *                       Returns: {runId, workflowRunId}
 *
 * GET  /smoke/:id     — replays the chunk stream for a workflow run id.
 *                       Returns the chunks as JSON for ergonomic curl-testing.
 *
 * This is throwaway scaffolding that goes away when the lead-agent workflow
 * lands.
 */
import { defineEventHandler, readBody } from 'h3'
import { start } from 'workflow/api'
import { smokeWorkflow } from '../../workflows/smoke.js'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ message?: string; ticks?: number }>(event)
  const message = body?.message ?? 'hello from the smoke test'
  const ticks = Math.max(1, Math.min(10, body?.ticks ?? 3))

  const run = await start(smokeWorkflow, [{ message, ticks }])
  return { workflowRunId: run.runId }
})
