/**
 * `GET /api/v1/teams` — list all teams.
 *
 * Wraps `TeamStore.list()`. Returns the small `TeamMeta` shape (name +
 * lead role + agent count); for full team config including prompts,
 * fetch by name via `GET /teams/:name`.
 */
import { defineEventHandler } from 'h3'
import { makeStores } from '../../../../../src/storage/factory.js'

export default defineEventHandler(async () => {
  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { teamStore } = await makeStores({ dataDir })
  const teams = await teamStore.list()
  return { teams }
})
