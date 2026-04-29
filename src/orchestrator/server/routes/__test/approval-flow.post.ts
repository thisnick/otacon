/**
 * Test-only route for `tests/orchestrator/e2e/test-approval-flow.ts`.
 *
 * Starts the `approvalFlowWorkflow` against a tmp data dir, returns the
 * runId + workflowRunId. The e2e test then drives:
 *   GET /api/v1/runs/:id/stream     (read chunks)
 *   POST /api/v1/signals/:id/resolve (resolve approval)
 *
 * Body: `{ command?, rationale?, toolCallId? }` — defaults provided.
 *
 * Sits under `__test/` so it's clearly internal. Remove alongside
 * approval-flow.ts when the lead-agent path takes over.
 */
import { defineEventHandler, readBody } from 'h3'
import { start } from 'workflow/api'
import { ulid } from 'ulid'
import { approvalFlowWorkflow } from '../../../workflows/approval-flow.js'
import { makeStores } from '../../../src/storage/factory.js'

interface Body {
  command?: string
  rationale?: string
  toolCallId?: string
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<Body>(event)) ?? {}
  const command = body.command ?? 'otacon tap eN'
  const rationale = body.rationale ?? 'test approval flow'
  const toolCallId = body.toolCallId ?? `tc-${ulid()}`

  // Create a RunStore record so /api/v1/runs/:id/stream can resolve our
  // runId → workflowRunId. Prompt snapshot is omitted — this is a
  // control-flow test, not an agent run.
  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { runStore } = await makeStores({ dataDir })
  const runId = ulid()
  await runStore.create({
    id: runId,
    account: 'xhs:test',
    team: '__test',
    agentRole: '__test',
    model: '__test',
  })

  const wf = await start(approvalFlowWorkflow, [{
    runId,
    command,
    rationale,
    toolCallId,
  }])
  await runStore.updateStatus(runId, 'running', { workflowRunId: wf.runId })

  return { runId, workflowRunId: wf.runId, toolCallId }
})
