/**
 * GET /smoke/:id — replay the chunk stream of a smoke run as JSON.
 *
 * Reads `run.getReadable({startIndex: 0})` to end and returns all chunks.
 * Validates that world-local persisted what `getWritable()` wrote.
 */
import { defineEventHandler, getRouterParam } from 'h3'
import { getRun } from 'workflow/api'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) return { error: 'missing run id' }

  const run = getRun(id)
  const exists = await run.exists
  if (!exists) return { error: `run ${id} not found` }

  const readable = run.getReadable({ startIndex: 0 })
  const tailIndex = await readable.getTailIndex()

  // The stream emits already-deserialized chunks (UIMessageChunk-shaped
  // objects). Just collect them — no SSE framing or byte decoding needed.
  const chunks: unknown[] = []
  const reader = readable.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  return {
    runId: id,
    status: await run.status,
    tailIndex,
    chunkCount: chunks.length,
    chunks,
  }
})
