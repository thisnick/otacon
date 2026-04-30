/**
 * Helpers for merging the WorkflowAgent's `ModelCallStreamPart` stream
 * with our orchestrator-emitted `UIMessageChunk` chunks (the "data"
 * namespace) into a single SSE response.
 *
 * Architecture (per `docs/orchestrator-v2-plan.md` §"Phase 6"):
 *
 *   - WorkflowAgent's `agent.stream({ writable })` writes ModelCallStreamPart.
 *     `createModelCallToUIChunkTransform()` is the canonical transform that
 *     converts those to UIMessageChunks. Crucially, the transform's `switch`
 *     is exhaustive on KNOWN model-call types — anything else (including
 *     our custom `data-*` chunks) returns `undefined` and is silently
 *     dropped.
 *
 *   - Our solution: emit custom `data-*` chunks via a SEPARATE workflow
 *     stream, namespaced. `getWritable<UIMessageChunk>({ namespace: 'data' })`
 *     gives us a stream that bypasses the agent transform. The route
 *     handler reads BOTH streams (default + 'data' namespace) and merges
 *     them into one outgoing UIMessageChunk SSE response.
 *
 * This module exposes the namespace constant + a small route-side helper
 * that wires the merge end-to-end.
 */
import type { Run } from '@workflow/core/runtime'
import type { UIMessageChunk } from 'ai'
import type { ModelCallStreamPart } from '@ai-sdk/workflow'

/**
 * Namespace for orchestrator-side custom `data-*` chunks (data-phone-action,
 * data-run-started, etc.). Steps grab this with
 * `getWritable<UIMessageChunk>({ namespace: DATA_NAMESPACE })`.
 *
 * Keep this value stable — changing it post-deploy invalidates any
 * in-flight workflow runs whose data-namespace stream uses the old name.
 */
export const DATA_NAMESPACE = 'data'

/**
 * Build the merged UIMessageChunk readable for an active workflow run.
 *
 * @param wfRun - Workflow `Run` returned by `getRun(runId)` or `start(...)`.
 * @param opts.startIndex - Optional resume index. Forwarded to BOTH the
 *   default and the data namespace. Negative values read from the end.
 *
 * Returns the two readables for the route to merge via
 * `createUIMessageStream({ execute: ({writer}) => { writer.merge(...) } })`.
 * Kept as a tuple instead of merging here so the route can also call
 * `getTailIndex()` on each side for the `x-workflow-stream-tail-index`
 * response header.
 */
export function getRunStreams<TResult>(
  wfRun: Run<TResult>,
  opts: { startIndex?: number } = {},
): {
  modelCall: ReturnType<Run<TResult>['getReadable']>
  data: ReturnType<Run<TResult>['getReadable']>
} {
  const startIndex = opts.startIndex
  const baseOpts = startIndex !== undefined ? { startIndex } : {}
  return {
    modelCall: wfRun.getReadable<ModelCallStreamPart>(baseOpts),
    data: wfRun.getReadable<UIMessageChunk>({ ...baseOpts, namespace: DATA_NAMESPACE }),
  }
}
