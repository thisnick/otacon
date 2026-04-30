/**
 * `DELETE /api/v1/accounts/:id/env/:file` — remove an env file.
 *
 * Same allowlist as GET/PUT. Idempotent: deleting an already-missing
 * file returns 200 with `{ok: true, deleted: false}`.
 */
import { defineEventHandler, getRouterParam, createError } from 'h3'
import { makeStores } from '../../../../../../../src/storage/factory.js'
import { accountEnvFile } from '../../../../../../../src/storage/paths.js'
import * as fsp from 'node:fs/promises'

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

  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { accountStore, layout } = await makeStores({ dataDir })
  const account = await accountStore.get(id)
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: `account ${id} not found` })
  }

  const absPath = accountEnvFile(layout, id, file)
  try {
    await fsp.unlink(absPath)
    return { ok: true, deleted: true }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, deleted: false }
    }
    throw e
  }
})
