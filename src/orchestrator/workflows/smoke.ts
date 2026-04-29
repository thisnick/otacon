/**
 * Smoke-test workflow used to verify the Nitro + workflow/nitro pipeline +
 * world-local persistence are wired correctly.
 *
 * This is throwaway scaffolding that validates the build & runtime path
 * before we land the real lead-agent workflow. Once the agent loop
 * migration commit lands, this file can be removed.
 *
 * It exercises:
 *   1. The SWC plugin's `"use workflow"` transform (assigns `workflowId`)
 *   2. The SWC plugin's `"use step"` transform (registers + replaces body)
 *   3. `getWritable<UIMessageChunk>()` from inside a step writing chunks to
 *      the workflow's default stream
 *   4. `world-local` persisting those chunks to ${ORCHESTRATOR_DATA_DIR}/workflow/
 *   5. `run.getReadable({startIndex: 0})` replaying them
 *
 * Architectural note: stream writes MUST happen inside steps, never in the
 * workflow body. The workflow body runs in a deterministic VM where
 * `WritableStream.getWriter()` is unavailable; only `"use step"` functions
 * have full Node access (see foundations/streaming docs).
 */
import { getWritable } from 'workflow'
import type { UIMessageChunk } from 'ai'

interface SmokeArgs {
  message: string
  ticks: number
}

interface SmokeResult {
  acknowledged: string
  ticksWritten: number
}

export async function smokeWorkflow(args: SmokeArgs): Promise<SmokeResult> {
  'use workflow'

  await emitStartedStep(args.message)

  let acked = ''
  for (let i = 0; i < args.ticks; i++) {
    acked = await ackAndEmitStep(args.message, i)
  }

  await emitCompletedStep(args.ticks, acked)

  return { acknowledged: `received: ${args.message}`, ticksWritten: args.ticks }
}

async function emitStartedStep(message: string): Promise<void> {
  'use step'
  const writer = getWritable<UIMessageChunk>().getWriter()
  try {
    await writer.write({
      type: 'data-run-started',
      id: 'smoke-start',
      data: { message },
    } as unknown as UIMessageChunk)
  } finally {
    writer.releaseLock()
  }
}

async function ackAndEmitStep(message: string, tick: number): Promise<string> {
  'use step'
  const ack = `${message} (#${tick})`
  const writer = getWritable<UIMessageChunk>().getWriter()
  try {
    await writer.write({
      type: 'text-delta',
      id: `tick-${tick}`,
      delta: `tick ${tick}: ${ack}\n`,
    } as unknown as UIMessageChunk)
  } finally {
    writer.releaseLock()
  }
  return ack
}

async function emitCompletedStep(ticks: number, acknowledged: string): Promise<void> {
  'use step'
  const writable = getWritable<UIMessageChunk>()
  const writer = writable.getWriter()
  try {
    await writer.write({
      type: 'data-run-completed',
      id: 'smoke-complete',
      data: { ticks, acknowledged },
    } as unknown as UIMessageChunk)
  } finally {
    writer.releaseLock()
  }
  // Close the stream so the GET /smoke/:id replay terminates instead of
  // tailing live forever.
  await writable.close()
}
