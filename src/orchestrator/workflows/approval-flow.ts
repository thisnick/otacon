/**
 * Test-only workflow that exercises the approval-gate path WITHOUT
 * involving DurableAgent or AI Gateway. Used by
 * `tests/orchestrator/e2e/test-approval-flow.ts` to verify the control
 * flow CLI ↔ server ↔ workflow ↔ approval ↔ stream replay end-to-end
 * before phase-1 commit-7b wires the real sandbox.
 *
 * Mirrors `leadAgentWorkflow`'s shape (lifecycle markers via steps,
 * approval hook via `defineHook().create({token})`, signal-resolved
 * marker via step) so an e2e that's green here is strong evidence that
 * the lead-agent flow will work too — modulo the DurableAgent-specific
 * pieces (model calls, tool dispatch).
 *
 * Stays in the tree as throwaway scaffolding; remove alongside
 * `workflows/smoke.ts` whenever the lead asks.
 */
import { getWritable } from 'workflow'
import type { UIMessageChunk } from 'ai'
import { approvalHook, approvalToken, persistSignal, signalIdFor } from '../src/run-executor/approval-bridge.js'

export interface ApprovalFlowArgs {
  runId: string
  command: string
  rationale: string
  toolCallId: string
}

export interface ApprovalFlowResult {
  decision: 'approve' | 'reject' | 'skip'
  message: string | null
}

export async function approvalFlowWorkflow(args: ApprovalFlowArgs): Promise<ApprovalFlowResult> {
  'use workflow'

  await emitStartedStep({ runId: args.runId })

  // IMPORTANT: create the hook BEFORE emitting data-signal-created.
  // Otherwise an external resolver that races on the chunk arrival could
  // POST /api/v1/signals/:id/resolve before the hook token is registered
  // with world-local, hitting HookNotFoundError. With this ordering the
  // SignalStore record + chunk emission happen only after world-local
  // has the hook indexed.
  const token = approvalToken(args.runId, args.toolCallId)
  const hook = approvalHook.create({ token })

  await persistSignalStep({
    runId: args.runId,
    toolCallId: args.toolCallId,
    command: args.command,
    rationale: args.rationale,
  })

  // SUSPEND. Resumed via POST /api/v1/signals/:id/resolve.
  const { decision, message } = await hook

  await emitResolvedStep({
    runId: args.runId,
    toolCallId: args.toolCallId,
    decision,
    message: message ?? null,
  })

  await emitCompletedStep({
    runId: args.runId,
    decision,
  })

  return { decision, message: message ?? null }
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

async function persistSignalStep(p: {
  runId: string
  toolCallId: string
  command: string
  rationale: string
}): Promise<void> {
  'use step'
  const { makeStores } = await import('../src/storage/factory.js')
  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { signalStore } = await makeStores({ dataDir })
  await persistSignal({
    signalStore,
    runId: p.runId,
    toolCallId: p.toolCallId,
    kind: 'approval',
    command: p.command,
    rationale: p.rationale,
  })
  const writer = getWritable<UIMessageChunk>().getWriter()
  try {
    await writer.write({
      type: 'data-signal-created',
      id: `signal-created:${p.runId}:${p.toolCallId}`,
      data: {
        signalId: signalIdFor(p.runId, p.toolCallId, 'approval'),
        kind: 'approval',
        toolCallId: p.toolCallId,
        command: p.command,
        rationale: p.rationale,
      },
    } as unknown as UIMessageChunk)
  } finally {
    writer.releaseLock()
  }
}

async function emitResolvedStep(p: {
  runId: string
  toolCallId: string
  decision: 'approve' | 'reject' | 'skip'
  message: string | null
}): Promise<void> {
  'use step'
  const writer = getWritable<UIMessageChunk>().getWriter()
  try {
    await writer.write({
      type: 'data-signal-resolved',
      id: `signal-resolved:${p.runId}:${p.toolCallId}`,
      data: {
        signalId: signalIdFor(p.runId, p.toolCallId, 'approval'),
        kind: 'approval',
        decision: p.decision,
        message: p.message,
      },
    } as unknown as UIMessageChunk)
  } finally {
    writer.releaseLock()
  }
}

async function emitCompletedStep(p: { runId: string; decision: string }): Promise<void> {
  'use step'
  const writable = getWritable<UIMessageChunk>()
  const writer = writable.getWriter()
  try {
    await writer.write({
      type: 'data-run-completed',
      id: `completed:${p.runId}`,
      data: { run_id: p.runId, decision: p.decision },
    } as unknown as UIMessageChunk)
  } finally {
    writer.releaseLock()
  }
  await writable.close()
}
