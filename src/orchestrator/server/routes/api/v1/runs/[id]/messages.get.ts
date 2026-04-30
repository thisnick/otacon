/**
 * `GET /api/v1/runs/:id/messages` — full conversation as `UIMessage[]`.
 *
 * Pipes `run.getReadable({startIndex: 0})` through `readUIMessageStream`
 * (AI SDK helper) to collect the persisted chunk stream into the canonical
 * UI-message structure the frontend renders.
 *
 * Returns `{messages: UIMessage[]}`. Never streams — this is a snapshot
 * of the complete conversation as of the moment of the request. For live
 * tail or replay-from-cursor, use `/stream`.
 *
 * 404 when:
 *   - run id unknown
 *   - run hasn't been assigned a workflowRunId yet (created but not started)
 *   - workflow run no longer present in the SDK's stream registry
 */
import { defineEventHandler, getRouterParam, createError } from 'h3'
import { getRun } from 'workflow/api'
import { readUIMessageStream } from 'ai'
import type { UIMessage, UIMessageChunk } from 'ai'
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
  if (!run.workflowRunId) {
    throw createError({
      statusCode: 503,
      statusMessage: `run ${id} has not yet been started (no workflowRunId)`,
    })
  }

  const wfRun = getRun<unknown>(run.workflowRunId)
  const exists = await wfRun.exists
  if (!exists) {
    throw createError({
      statusCode: 404,
      statusMessage: `workflow run ${run.workflowRunId} not found`,
    })
  }

  const readable = wfRun.getReadable<UIMessageChunk>({ startIndex: 0 })

  // readUIMessageStream returns an AsyncIterable<UIMessage>; the iterator
  // emits the message at each progress point. We just collect the
  // terminal snapshot (last per id wins) and return the array.
  const stream = readUIMessageStream({ stream: readable })
  const byId = new Map<string, UIMessage>()
  for await (const msg of stream) {
    byId.set(msg.id, msg)
  }
  const messages = [...byId.values()]

  return { messages }
})
