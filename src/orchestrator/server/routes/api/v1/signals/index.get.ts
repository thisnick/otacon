/**
 * `GET /api/v1/signals[?status=&run_id=]` — list signals.
 *
 * Wraps `SignalStore.list({status, runId})`. The store walks
 * `runs/* /signals/*.json`, so this scales fine for the per-run signal
 * counts we expect (typically <10 per run).
 *
 * Query parameters:
 *   - `status` — `pending` | `approved` | `rejected` | `skipped`
 *   - `run_id` — restrict to one run
 *
 * Returns `{signals: Signal[]}` newest-first by `createdAt`.
 */
import { defineEventHandler, getQuery, createError } from 'h3'
import { makeStores } from '../../../../../src/storage/factory.js'
import type { SignalStatus } from '../../../../../src/storage/types.js'

const ALLOWED_STATUSES: ReadonlySet<SignalStatus> = new Set([
  'pending',
  'approved',
  'rejected',
  'skipped',
])

export default defineEventHandler(async (event) => {
  const query = getQuery(event)

  let status: SignalStatus | undefined
  if (typeof query.status === 'string' && query.status !== '') {
    if (!ALLOWED_STATUSES.has(query.status as SignalStatus)) {
      throw createError({
        statusCode: 400,
        statusMessage: `invalid status "${query.status}" — must be one of: ${[...ALLOWED_STATUSES].join(', ')}`,
      })
    }
    status = query.status as SignalStatus
  }

  const runId = typeof query.run_id === 'string' && query.run_id !== ''
    ? query.run_id
    : undefined

  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { signalStore } = await makeStores({ dataDir })
  const signals = await signalStore.list({ runId, status })
  // Newest-first.
  signals.sort((a, b) => b.createdAt - a.createdAt)

  return { signals }
})
