/**
 * Test-only route — starts `failureFlowWorkflow` so the e2e can verify
 * a thrown step is caught + closed with `data-run-failed`.
 */
import { defineEventHandler, readBody } from 'h3'
import { start } from 'workflow/api'
import { ulid } from 'ulid'
import { failureFlowWorkflow } from '../../../workflows/failure-flow.js'
import { makeStores } from '../../../src/storage/factory.js'

interface Body {
  message?: string
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<Body>(event)) ?? {}
  const message = body.message ?? 'synthetic failure for the e2e suite'

  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { runStore } = await makeStores({ dataDir })
  const runId = ulid()
  await runStore.create({
    id: runId,
    account: '__test',
    team: '__test',
    agentRole: '__test',
    model: '__test',
  })

  const wf = await start(failureFlowWorkflow, [{ runId, message }])
  await runStore.updateStatus(runId, 'running', { workflowRunId: wf.runId })
  return { runId, workflowRunId: wf.runId }
})
