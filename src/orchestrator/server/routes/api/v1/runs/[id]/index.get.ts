/**
 * `GET /api/v1/runs/:id` — run metadata.
 *
 * Reads `runs/{id}/run.json` via `RunStore.get`. 404 when not found.
 *
 * Returns the full `Run` shape (id, workflowRunId, account, team,
 * agentRole, model, status, startedAt, completedAt, finalText,
 * turnCount, error, promptTemplatePaths, promptSnapshotPath,
 * initialPrompt). The chunk stream lives at `/stream`; this endpoint
 * is for the metadata only.
 */
import { defineEventHandler, getRouterParam, createError } from 'h3'
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

  return run
})
