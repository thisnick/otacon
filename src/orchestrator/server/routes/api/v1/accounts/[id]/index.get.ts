/**
 * `GET /api/v1/accounts/:id` — single account metadata.
 *
 * 404 when the account doesn't exist.
 */
import { defineEventHandler, getRouterParam, createError } from 'h3'
import { makeStores } from '../../../../../../src/storage/factory.js'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id', { decode: true })
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'missing account id' })
  }
  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { accountStore } = await makeStores({ dataDir })
  const account = await accountStore.get(id)
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: `account ${id} not found` })
  }
  return { account }
})
