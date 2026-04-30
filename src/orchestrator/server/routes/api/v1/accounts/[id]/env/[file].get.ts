/**
 * `GET /api/v1/accounts/:id/env/:file` — read an env file (markdown).
 *
 * The env files are fixed-name templates the prompt builder reads at run
 * start. Allowlist enforced — anything else returns 400 (we don't expose
 * arbitrary FS).
 *
 * Allowed: `persona.md`, `soul.md`, `agents.md`.
 *
 * 404 when the account or the file doesn't exist on disk.
 */
import { defineEventHandler, getRouterParam, createError, setHeader } from 'h3'
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
  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { accountStore } = await makeStores({ dataDir })

  // Confirm the account exists first so we can return a meaningful 404.
  const account = await accountStore.get(id)
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: `account ${id} not found` })
  }
  const content = await accountStore.readEnvFile(id, file)
  if (content === null) {
    throw createError({
      statusCode: 404,
      statusMessage: `env file ${file} not found for account ${id}`,
    })
  }
  setHeader(event, 'content-type', 'text/markdown; charset=utf-8')
  return content
})
