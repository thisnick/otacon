/**
 * `GET /api/v1/runs/:id/traces/:tcid/:file` — serve a trace artifact.
 *
 * Backs the URLs that `data-phone-action` chunks reference (P2's
 * `screenshots.{before,annotated,after}` and the existing `result.json`
 * sidecar). Reads from the FS-backed run-trace dir
 * (`<dataDir>/runs/{runId}/traces/{toolCallId}/{file}`).
 *
 * Allowed `:file` values (allowlist — anything else is 404):
 *   - before.png
 *   - annotated.png
 *   - after.png
 *   - result.json
 *
 * The IDs are validated via `assertSafeId` in the path layout helpers,
 * which already reject path-traversal attempts. The `:file` segment is
 * matched against the allowlist above before any disk access.
 */
import { defineEventHandler, getRouterParam, createError, setHeader } from 'h3'
import { runTraceFile } from '../../../../../../../../src/storage/paths.js'
import { makeStores } from '../../../../../../../../src/storage/factory.js'
import * as fsp from 'node:fs/promises'

const ALLOWED_FILES: ReadonlyMap<string, string> = new Map([
  ['before.png', 'image/png'],
  ['annotated.png', 'image/png'],
  ['after.png', 'image/png'],
  ['result.json', 'application/json'],
])

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const tcid = getRouterParam(event, 'tcid')
  const file = getRouterParam(event, 'file')
  if (!id || !tcid || !file) {
    throw createError({ statusCode: 400, statusMessage: 'missing run id, tool-call id, or file segment' })
  }

  const contentType = ALLOWED_FILES.get(file)
  if (!contentType) {
    throw createError({
      statusCode: 404,
      statusMessage: `unsupported trace file "${file}" — allowed: ${[...ALLOWED_FILES.keys()].join(', ')}`,
    })
  }

  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { layout } = await makeStores({ dataDir })

  let absPath: string
  try {
    absPath = runTraceFile(layout, id, tcid, file)
  } catch (e) {
    throw createError({ statusCode: 400, statusMessage: (e as Error).message })
  }

  let bytes: Buffer
  try {
    bytes = await fsp.readFile(absPath)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw createError({
        statusCode: 404,
        statusMessage: `trace file not found: runs/${id}/traces/${tcid}/${file}`,
      })
    }
    throw e
  }

  setHeader(event, 'content-type', contentType)
  setHeader(event, 'content-length', String(bytes.length))
  // Trace artifacts are immutable once written (each tool-call id is
  // unique to its run + invocation). Long-cache them. The hash is in
  // the URL path itself via the toolCallId segment.
  setHeader(event, 'cache-control', 'public, max-age=31536000, immutable')
  return bytes
})
