/**
 * Per-run sandbox cache.
 *
 * The lead-agent workflow's bash tool calls `getSandbox({runId, accountId})`
 * from inside a step. The first call for a given `runId` constructs:
 *   - a `LocalBlobStore` rooted at `${ORCHESTRATOR_DATA_DIR}/blobs`
 *   - a fresh `AllocationContext`
 *   - upserts a Drizzle `conversations` row with id=runId (allocations
 *     FK-references conversations; runId substitutes for conversationId
 *     until the allocations FS migration in a follow-up commit)
 *   - calls `buildSandbox(...)` which returns a `Bash` configured with
 *     the otacon + otacon-alloc custom commands
 *
 * Subsequent calls with the same `runId` return the cached `Bash`. We key
 * by `runId` (not `accountId`) because:
 *   - workspaces are scoped per account but otacon-alloc state is per
 *     conversation/run, so two runs against the same account shouldn't
 *     share an `AllocationContext` lest they fight over the lease
 *   - the workflow runtime might torn down + reconstruct module scope
 *     across step invocations, but the cache fast-path for a single
 *     warm process saves a few hundred ms of DB roundtrips per call
 *
 * The cache is a `Promise<Bash>` so concurrent first-callers all await
 * the same construction.
 */
import type { Bash } from 'just-bash'
import { sql } from 'drizzle-orm'
import { LocalBlobStore } from '../storage/blob.js'
import { buildSandbox } from '../sandbox/build.js'
import { AllocationContext } from '../sandbox/allocation-context.js'
import { createDb } from '../db/client.js'

export const blobRoot = process.env.ORCHESTRATOR_BLOB_ROOT
  ?? `${process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'}/blobs`

const cache = new Map<string, Promise<Bash>>()

export async function getSandbox(opts: {
  runId: string
  accountId: string
}): Promise<Bash> {
  const existing = cache.get(opts.runId)
  if (existing) return existing
  const promise = build(opts).catch((err) => {
    // Don't trap the failure in the cache — let the next caller retry.
    cache.delete(opts.runId)
    throw err
  })
  cache.set(opts.runId, promise)
  return promise
}

async function build(opts: { runId: string; accountId: string }): Promise<Bash> {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL not set; sandbox needs the legacy DB until allocations migrate to FS')
  }
  const db = createDb(url)

  // Ensure a conversations row exists for runId so phone_allocations can
  // FK-reference it. Idempotent — `ON CONFLICT DO NOTHING` is the simple
  // form here. Use raw SQL to avoid hauling in the schema's pg-core types.
  await db.execute(sql`
    INSERT INTO conversations (id, conversation_key, blob_path, status)
    VALUES (
      ${opts.runId},
      ${`run:${opts.runId}`},
      ${`runs/${opts.runId}/conversation`},
      'active'
    )
    ON CONFLICT (id) DO NOTHING
  `)

  const blobStore = new LocalBlobStore(blobRoot)
  const allocCtx = new AllocationContext()

  return await buildSandbox({
    blobStore,
    accountId: opts.accountId,
    conversationId: opts.runId,
    db,
    allocCtx,
  })
}

/**
 * Test-only cache reset. Used by the e2e suite to start each run with a
 * fresh sandbox; not exported under normal use.
 */
export function __resetCache(): void {
  cache.clear()
}
