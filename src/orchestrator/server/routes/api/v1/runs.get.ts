/**
 * `GET /api/v1/runs[?account=&status=&team=&limit=&beforeId=]` — list runs.
 *
 * Reads from the FS-backed `IndexStore` (jsonl), dedupes by run id
 * (last-write-wins per the index's append semantics), filters/sorts in
 * memory. Pairs with `RunStore.list()` — no DB.
 *
 * Query parameters:
 *   - `account`   filter to a single account id (e.g. `xhs:test`)
 *   - `status`    filter to one of: created | running | completed | failed | cancelled
 *   - `team`      filter to a team name
 *   - `limit`     max rows to return (default 50, capped at 500)
 *   - `beforeId`  return only runs older than the given run id (cursor)
 *
 * Returns `{runs: RunIndexEntry[]}` newest-first.
 */
import { defineEventHandler, getQuery, createError } from 'h3'
import { makeStores } from '../../../../src/storage/factory.js'
import type { RunStatus } from '../../../../src/storage/types.js'


const ALLOWED_STATUSES: ReadonlySet<RunStatus> = new Set([
  'created',
  'running',
  'completed',
  'failed',
  'cancelled',
])

export default defineEventHandler(async (event) => {
  const query = getQuery(event)

  const account = typeof query.account === 'string' ? query.account : undefined
  const team = typeof query.team === 'string' ? query.team : undefined
  const beforeId = typeof query.beforeId === 'string' ? query.beforeId : undefined

  let status: RunStatus | undefined
  if (typeof query.status === 'string' && query.status !== '') {
    if (!ALLOWED_STATUSES.has(query.status as RunStatus)) {
      throw createError({
        statusCode: 400,
        statusMessage: `invalid status "${query.status}" — must be one of: ${[...ALLOWED_STATUSES].join(', ')}`,
      })
    }
    status = query.status as RunStatus
  }

  let limit = 50
  if (typeof query.limit === 'string' && query.limit !== '') {
    const parsed = Number(query.limit)
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw createError({ statusCode: 400, statusMessage: 'limit must be a non-negative number' })
    }
    limit = Math.min(500, Math.floor(parsed))
  }

  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { indexStore } = await makeStores({ dataDir })
  const runs = await indexStore.list({ account, team, status, limit, beforeId })

  return { runs }
})
