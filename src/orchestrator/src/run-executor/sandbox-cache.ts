/**
 * Per-run sandbox cache.
 *
 * The lead-agent workflow's bash tool calls `getSandbox({runId, accountId})`
 * from inside a step. The first call for a given `runId` constructs:
 *   - a `LocalBlobStore` rooted at `${ORCHESTRATOR_DATA_DIR}/blobs`
 *   - a fresh `AllocationContext`
 *   - calls `buildSandboxFs(...)` which returns a `Bash` configured
 *     with the otacon + otacon-alloc custom commands and the FS-backed
 *     `AllocationStore`
 *
 * Subsequent calls with the same `runId` return the cached `Bash`. We key
 * by `runId` (not `accountId`) because:
 *   - workspaces are scoped per account but otacon-alloc state is per
 *     run, so two runs against the same account shouldn't share an
 *     `AllocationContext` lest they fight over the lease
 *   - the workflow runtime might tear down + reconstruct module scope
 *     across step invocations, but the cache fast-path for a single
 *     warm process saves a few hundred ms of resolution roundtrips
 *     per call
 *
 * The cache is a `Promise<Bash>` so concurrent first-callers all await
 * the same construction.
 */
import type { Bash } from 'just-bash'
import { LocalBlobStore } from '../storage/blob.js'
import { buildSandboxFs } from '../sandbox/build-fs.js'
import { AllocationContext } from '../sandbox/allocation-context.js'
import { makeStores } from '../storage/factory.js'

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
  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { allocationStore } = await makeStores({ dataDir })
  const blobStore = new LocalBlobStore(blobRoot)
  const allocCtx = new AllocationContext()
  return await buildSandboxFs({
    blobStore,
    accountId: opts.accountId,
    runId: opts.runId,
    allocationStore,
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
