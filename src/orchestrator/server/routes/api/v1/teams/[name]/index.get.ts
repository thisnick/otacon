/**
 * `GET /api/v1/teams/:name` — full team config (lead role + agents map +
 * prompt template paths).
 *
 * 404 when the team doesn't exist. The actual prompt content lives in
 * `runs/{runId}/prompt.md` once a run is started (snapshotted), or in
 * `teams/{name}/prompts/{file}` for the live template — fetch the latter
 * via the (planned) `/teams/:name/prompts/:file` endpoint if needed; for
 * now this just exposes the team config blob.
 */
import { defineEventHandler, getRouterParam, createError } from 'h3'
import { makeStores } from '../../../../../../src/storage/factory.js'

export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name', { decode: true })
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'missing team name' })
  }
  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { teamStore } = await makeStores({ dataDir })
  const team = await teamStore.get(name)
  if (!team) {
    throw createError({ statusCode: 404, statusMessage: `team ${name} not found` })
  }
  return { team }
})
