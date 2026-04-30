/**
 * `GET /api/v1/runs/:id/prompt` — snapshotted system prompt as plaintext.
 *
 * Reads `runs/{id}/prompt.md` via `RunStore.getPromptSnapshot`. The
 * orchestrator writes this snapshot at run start so the prompt the model
 * actually saw is preserved verbatim, regardless of subsequent template
 * edits.
 *
 * 404 when the run doesn't exist OR the prompt file is missing (which
 * means the run hasn't started yet).
 */
import { defineEventHandler, getRouterParam, createError, setHeader } from 'h3'
import { makeStores } from '../../../../../../src/storage/factory.js'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id', { decode: true })
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'missing run id' })
  }

  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { runStore } = await makeStores({ dataDir })
  const run = await runStore.get(id)
  if (!run) {
    throw createError({ statusCode: 404, statusMessage: `run ${id} not found` })
  }
  const prompt = await runStore.getPromptSnapshot(id)
  if (prompt === null) {
    throw createError({
      statusCode: 404,
      statusMessage: `prompt snapshot not found for run ${id}`,
    })
  }

  setHeader(event, 'content-type', 'text/markdown; charset=utf-8')
  return prompt
})
