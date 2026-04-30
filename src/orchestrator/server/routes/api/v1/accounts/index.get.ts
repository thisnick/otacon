/**
 * `GET /api/v1/accounts` — list all accounts.
 *
 * Wraps `AccountStore.list()`. Each account is the full `Account` shape
 * (id, displayName, accountType, status, config, createdAt).
 *
 * Returns `{accounts: Account[]}`. Order matches the `accounts/` dirent
 * listing; future filters/sort can be layered on without changing the
 * envelope.
 */
import { defineEventHandler } from 'h3'
import { makeStores } from '../../../../../src/storage/factory.js'

export default defineEventHandler(async () => {
  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { accountStore } = await makeStores({ dataDir })
  const accounts = await accountStore.list()
  return { accounts }
})
