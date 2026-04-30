/**
 * Test-only workflow that always throws inside the workflow body. Used
 * by the e2e suite to verify that the failure path closes the stream
 * with a `data-run-failed` chunk so the CLI exits cleanly even when
 * `agent.stream()` (or any other in-loop step) throws.
 *
 * Companion to `approval-flow.ts`. Remove with the rest of the
 * test-only workflows whenever the lead asks.
 */
import { getWritable } from 'workflow'
import type { UIMessageChunk } from 'ai'

export interface FailureFlowArgs {
  runId: string
  /** What error message should the synthetic throw produce? */
  message: string
}

export async function failureFlowWorkflow(args: FailureFlowArgs): Promise<{ status: 'failed' }> {
  'use workflow'

  await emitStartedStep({ runId: args.runId })

  try {
    await throwingStep(args.message)
  } catch (e) {
    await emitFailedStep({ runId: args.runId, error: errMsg(e) })
    return { status: 'failed' }
  }

  // Unreachable in this workflow, but TS needs the return.
  return { status: 'failed' }
}

async function throwingStep(message: string): Promise<never> {
  'use step'
  throw new Error(message)
}

async function emitStartedStep(p: { runId: string }): Promise<void> {
  'use step'
  const writer = getWritable<UIMessageChunk>().getWriter()
  try {
    await writer.write({
      type: 'data-run-started',
      id: `started:${p.runId}`,
      data: { run_id: p.runId },
    } as unknown as UIMessageChunk)
  } finally {
    writer.releaseLock()
  }
}

async function emitFailedStep(p: { runId: string; error: string }): Promise<void> {
  'use step'
  const writable = getWritable<UIMessageChunk>()
  const writer = writable.getWriter()
  try {
    await writer.write({
      type: 'data-run-failed',
      id: `failed:${p.runId}`,
      data: { run_id: p.runId, error: p.error },
    } as unknown as UIMessageChunk)
  } finally {
    writer.releaseLock()
  }
  await writable.close()
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
