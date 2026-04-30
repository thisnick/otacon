/**
 * `GET /api/v1/runs/:id/stream[?startIndex=N]` — SSE stream of UIMessageChunks.
 *
 * Wraps the run's chunk stream from Workflow SDK in AI SDK's SSE framing.
 * `:id` is our orchestrator runId (ULID); we resolve it to the
 * Workflow SDK's `workflowRunId` via RunStore.
 *
 * `startIndex` semantics (per Workflow SDK):
 *   - omitted    → live tail (only chunks written from this point onward)
 *   - 0          → from the very beginning
 *   - positive N → from chunk index N (resume after disconnect)
 *   - negative N → last |N| chunks (e.g. -10 = last 10)
 *
 * Response headers:
 *   - x-workflow-run-id: the Workflow SDK runId
 *   - x-workflow-stream-tail-index: the chunk index of the last known
 *     chunk at the time the stream opens — clients use this to resume
 *     after a disconnect
 */
import { defineEventHandler, getRouterParam, getQuery, createError, setHeader } from 'h3'
import { getRun } from 'workflow/api'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import type { UIMessageChunk } from 'ai'
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
    throw createError({ statusCode: 404, statusMessage: `workflow run ${run.workflowRunId} not found` })
  }

  const query = getQuery(event)
  const startIndexRaw = typeof query.startIndex === 'string' ? query.startIndex : undefined
  const startIndex =
    startIndexRaw !== undefined && startIndexRaw !== '' ? Number(startIndexRaw) : undefined
  if (startIndex !== undefined && Number.isNaN(startIndex)) {
    throw createError({ statusCode: 400, statusMessage: 'startIndex must be a number' })
  }

  const readable = wfRun.getReadable<UIMessageChunk>(
    startIndex !== undefined ? { startIndex } : {},
  )
  const tailIndex = await readable.getTailIndex()

  setHeader(event, 'x-workflow-run-id', run.workflowRunId)
  setHeader(event, 'x-workflow-stream-tail-index', String(tailIndex))

  // Wrap Workflow SDK's chunk stream in AI SDK's SSE framing. createUIMessageStream
  // gives us a properly framed stream; createUIMessageStreamResponse builds the
  // Response with correct content-type + cache-control headers.
  const uiStream = createUIMessageStream({
    execute: async ({ writer }) => {
      const reader = readable.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) writer.write(value)
        }
      } finally {
        reader.releaseLock()
      }
    },
  })

  // Return the AI-SDK-framed Response directly. (Earlier attempts to wrap
  // it in `sendStream(event, response.body!)` triggered "Response body
  // object should not be disturbed or locked" in h3's youch error
  // pipeline when something else read the body.) h3 picks up the
  // headers we already set via setHeader() and merges them with the
  // Response's content-type / cache-control.
  return createUIMessageStreamResponse({ stream: uiStream })
})
