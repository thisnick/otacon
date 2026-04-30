/**
 * `PUT /api/v1/accounts/:id/env/:file` — replace an env file's content.
 *
 * Body: raw markdown (the route reads `event.node.req` as a UTF-8
 * string). Same fixed-name allowlist as GET — `persona.md`, `soul.md`,
 * `agents.md`. Anything else returns 400.
 *
 * 404 when the account doesn't exist; we don't auto-create on PUT (the
 * caller already had to create the account first via POST /accounts).
 */
import { defineEventHandler, getRouterParam, readRawBody, createError } from 'h3'
import { makeStores } from '../../../../../../../src/storage/factory.js'

const ALLOWED_ENV_FILES: ReadonlySet<string> = new Set(['persona.md', 'soul.md', 'agents.md'])

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id', { decode: true })
  const file = getRouterParam(event, 'file', { decode: true })
  if (!id || !file) {
    throw createError({ statusCode: 400, statusMessage: 'missing account id or file segment' })
  }
  if (!ALLOWED_ENV_FILES.has(file)) {
    throw createError({
      statusCode: 400,
      statusMessage: `unsupported env file "${file}" — allowed: ${[...ALLOWED_ENV_FILES].join(', ')}`,
    })
  }
  const body = await readRawBody(event, 'utf-8')
  if (typeof body !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'request body required (text/markdown)' })
  }

  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { accountStore } = await makeStores({ dataDir })
  const account = await accountStore.get(id)
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: `account ${id} not found` })
  }
  await accountStore.writeEnvFile(id, file, body)
  return { ok: true, file, bytes: Buffer.byteLength(body, 'utf-8') }
})
