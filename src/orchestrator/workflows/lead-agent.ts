/**
 * `leadAgentWorkflow` — the durable workflow body that drives a single
 * lead-agent run end-to-end.
 *
 * Architecture (per workflow/docs/foundations/streaming + ai/human-in-the-loop):
 * - This function is the workflow body (deterministic VM, no Node access).
 * - All non-deterministic work (model calls, file reads, sandbox exec)
 *   lives inside `'use step'` functions.
 * - Stream writes (`getWritable().getWriter().write(...)`) happen ONLY in
 *   steps. Calling `.getWriter()` from the workflow body throws ENOTSUP.
 * - Approval gates use `defineHook().create({token})` — `.create()` itself
 *   IS workflow-level (not step-level), so the bash tool's `execute` runs
 *   without `'use step'` and acquires its hook there.
 *
 * For Phase 1, the bash tool is a placeholder that always requests
 * approval, then returns a stub. Commit 6 wires the real sandbox + bash
 * exec; commit 7 connects the route + CLI.
 *
 * Stream chunks emitted (in order):
 *   data-run-started   (lifecycle marker — agent run begins)
 *   <agent.stream(...) chunks: text-delta, tool-call, tool-result, ...>
 *   data-run-completed | data-run-failed | data-run-cancelled
 *
 * Each step that emits a chunk acquires `getWritable().getWriter()`
 * inside the step body, writes, releases the lock.
 */
import { DurableAgent } from '@workflow/ai/agent'
import { gateway } from '@ai-sdk/gateway'
import { tool } from 'ai'
import { getWritable } from 'workflow'
import { z } from 'zod'
import type { ModelMessage, UIMessageChunk } from 'ai'
import {
  approvalHook,
  approvalToken,
  persistSignal,
} from '../src/run-executor/approval-bridge.js'

export interface LeadAgentArgs {
  /** Our orchestrator run id (ULID). Different from the workflowRunId. */
  runId: string
  /** Account id (e.g. "xhs:test"). */
  accountId: string
  /** Team name (e.g. "social-media-engagement"). */
  team: string
  /** Agent role within the team (e.g. "engagement-lead"). */
  agentRole: string
  /** AI Gateway model identifier (e.g. "alibaba/qwen3.6-plus"). */
  model: string
  /** Snapshotted system prompt — already rendered, written to runs/{id}/prompt.md. */
  systemPrompt: string
  /** Optional initial user message. If absent, the agent gets a continuation nudge. */
  initialPrompt?: string
}

export interface LeadAgentResult {
  finalText: string
  turnCount: number
  status: 'completed' | 'failed' | 'cancelled'
}

const MAX_TURNS = 50

export async function leadAgentWorkflow(args: LeadAgentArgs): Promise<LeadAgentResult> {
  'use workflow'

  await emitRunStartedStep({
    runId: args.runId,
    accountId: args.accountId,
    team: args.team,
    agentRole: args.agentRole,
    model: args.model,
    initialPrompt: args.initialPrompt ?? null,
  })

  const agent = new DurableAgent({
    model: () => Promise.resolve(gateway(args.model as Parameters<typeof gateway>[0])),
    instructions: args.systemPrompt,
    tools: buildTools(args.runId),
  })

  const initialMessages: ModelMessage[] = [
    {
      role: 'user',
      content:
        args.initialPrompt ??
        'Begin your work. Check your instructions and proceed.',
    } as ModelMessage,
  ]

  let messages = initialMessages
  let finalText = ''
  let terminated = false

  try {
    for (let turn = 0; turn < MAX_TURNS && !terminated; turn++) {
      const result = await agent.stream({
        messages,
        writable: getWritable<UIMessageChunk>(),
        preventClose: turn < MAX_TURNS - 1,
      })
      messages = result.messages

      const last = messages[messages.length - 1]
      if (last?.role === 'assistant') {
        finalText = extractText(last)
      }

      const lastStep = result.steps[result.steps.length - 1]
      if (lastStep?.finishReason === 'stop') {
        terminated = true
      }
    }
  } catch (e) {
    await emitRunFailedStep({ runId: args.runId, error: errorMessage(e) })
    return { finalText, turnCount: messages.length, status: 'failed' }
  }

  await emitRunCompletedStep({
    runId: args.runId,
    finalText,
    turnCount: messages.length,
  })

  return { finalText, turnCount: messages.length, status: 'completed' }
}

// ────────────────────────── tools ───────────────────────────

interface ToolFactoryCtx {
  runId: string
}

function buildTools(runId: string) {
  const ctx: ToolFactoryCtx = { runId }
  return {
    bash: bashTool(ctx),
    escalate: escalateTool(ctx),
  }
}

/**
 * Placeholder bash tool. Asks for approval, then returns a stub. The real
 * sandbox + exec wiring lands in a follow-up commit; for now this validates
 * the approval path through `agent.stream` end-to-end.
 *
 * Notably: NO `'use step'` here. The execute function runs in workflow
 * context so it can acquire a hook via `approvalHook.create()`. Inside it
 * we still call `'use step'` helpers (`persistSignal`) for non-deterministic
 * IO — those live in approval-bridge.ts.
 */
function bashTool(ctx: ToolFactoryCtx) {
  return tool({
    description:
      'Run a bash command in the sandbox. (Placeholder for the orchestrator-v2 P1 commit-5 milestone — gates on human approval, then returns a stubbed message. Real exec wiring lands in a follow-up commit.)',
    inputSchema: z.object({
      command: z.string().describe('The bash command to run.'),
      rationale: z.string().describe('Why you are running this command.'),
    }),
    execute: async ({ command, rationale }, opts: { toolCallId: string }) => {
      const toolCallId = opts.toolCallId
      const token = approvalToken(ctx.runId, toolCallId)

      // IMPORTANT: hook creation must precede the data-signal-created
      // chunk emission. Otherwise a CLI/UI that races on the chunk could
      // POST resolve before world-local has the hook token indexed,
      // hitting HookNotFoundError.
      const hook = approvalHook.create({ token })

      // Persist signal metadata + emit data-signal-created (step). Now
      // that the hook is registered, external resolvers can find it via
      // SignalStore.getByHookToken.
      await persistSignalForBashStep({
        runId: ctx.runId,
        toolCallId,
        command,
        rationale,
      })

      // SUSPEND. Workflow durably waits here.
      const { decision, message } = await hook

      // Emit data-signal-resolved (step) so observers can fold the
      // approval card closed. Mark the SignalStore row resolved here too
      // so the in-process resolve route doesn't have to.
      await emitSignalResolvedStep({
        runId: ctx.runId,
        toolCallId,
        kind: 'approval',
        decision,
        message: message ?? null,
      })

      if (decision === 'reject') return `Action rejected: ${message ?? 'no reason given'}`
      if (decision === 'skip') return `Session skipped by approver: ${message ?? 'no reason given'}`
      return `[stub] would run: ${command}\n(approval recorded; real exec wiring lands in a follow-up commit)`
    },
  })
}

/**
 * Escalation tool — agent asks the human for guidance when stuck. Same
 * shape as bash; uses the escalation hook + signal kind.
 */
function escalateTool(ctx: ToolFactoryCtx) {
  return tool({
    description: 'Pause and ask the user for help. Use when stuck, unsure, or need guidance.',
    inputSchema: z.object({
      issue: z.string().describe('Description of the issue or question.'),
    }),
    execute: async ({ issue }, opts: { toolCallId: string }) => {
      const toolCallId = opts.toolCallId
      const token = `escalation:${ctx.runId}:${toolCallId}`
      // Hook before chunk emission — see bashTool's note for the
      // race-condition rationale.
      const hook = approvalHook.create({ token })
      await persistSignalForEscalateStep({
        runId: ctx.runId,
        toolCallId,
        rationale: issue,
      })
      const { decision, message } = await hook
      await emitSignalResolvedStep({
        runId: ctx.runId,
        toolCallId,
        kind: 'escalation',
        decision,
        message: message ?? null,
      })
      if (decision === 'approve') return `User approved. Continue with your plan.${message ? ` Note: ${message}` : ''}`
      return `User responded: ${decision}${message ? ` — ${message}` : ''}`
    },
  })
}

// ──────────────────────── step boundaries ───────────────────

interface RunStartedPayload {
  runId: string
  accountId: string
  team: string
  agentRole: string
  model: string
  initialPrompt: string | null
}

async function emitRunStartedStep(p: RunStartedPayload): Promise<void> {
  'use step'
  const writer = getWritable<UIMessageChunk>().getWriter()
  try {
    await writer.write({
      type: 'data-run-started',
      id: `started:${p.runId}`,
      data: {
        run_id: p.runId,
        account: p.accountId,
        team: p.team,
        agent_role: p.agentRole,
        model: p.model,
        initial_prompt: p.initialPrompt,
      },
    } as unknown as UIMessageChunk)
  } finally {
    writer.releaseLock()
  }
}

async function emitRunCompletedStep(p: { runId: string; finalText: string; turnCount: number }): Promise<void> {
  'use step'
  const writable = getWritable<UIMessageChunk>()
  const writer = writable.getWriter()
  try {
    await writer.write({
      type: 'data-run-completed',
      id: `completed:${p.runId}`,
      data: { run_id: p.runId, final_text: p.finalText, turn_count: p.turnCount },
    } as unknown as UIMessageChunk)
  } finally {
    writer.releaseLock()
  }
  await writable.close()
}

async function emitRunFailedStep(p: { runId: string; error: string }): Promise<void> {
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

// ────── signal-persisting steps (delegate to approval-bridge) ──────

async function emitSignalResolvedStep(p: {
  runId: string
  toolCallId: string
  kind: 'approval' | 'escalation'
  decision: 'approve' | 'reject' | 'skip'
  message: string | null
}): Promise<void> {
  'use step'
  const { makeStores } = await import('../src/storage/factory.js')
  const { signalIdFor } = await import('../src/run-executor/approval-bridge.js')
  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { signalStore } = await makeStores({ dataDir })
  const signalId = signalIdFor(p.runId, p.toolCallId, p.kind)
  // Mark resolved (idempotent — overwrites if already-resolved by the
  // route handler).
  try {
    await signalStore.markResolved(signalId, p.decision, p.message ?? undefined)
  } catch {
    // Signal might have been marked resolved by the HTTP route already;
    // not fatal.
  }
  const writer = getWritable<UIMessageChunk>().getWriter()
  try {
    await writer.write({
      type: 'data-signal-resolved',
      id: `signal-resolved:${p.runId}:${p.toolCallId}`,
      data: {
        signalId,
        kind: p.kind,
        decision: p.decision,
        message: p.message,
      },
    } as unknown as UIMessageChunk)
  } finally {
    writer.releaseLock()
  }
}

async function persistSignalForBashStep(p: {
  runId: string
  toolCallId: string
  command: string
  rationale: string
}): Promise<void> {
  'use step'
  const { makeStores } = await import('../src/storage/factory.js')
  const { signalIdFor } = await import('../src/run-executor/approval-bridge.js')
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
  // Emit a chunk so the CLI / web UI knows there's a pending approval
  // without polling the SignalStore.
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

async function persistSignalForEscalateStep(p: {
  runId: string
  toolCallId: string
  rationale: string
}): Promise<void> {
  'use step'
  const { makeStores } = await import('../src/storage/factory.js')
  const { signalIdFor } = await import('../src/run-executor/approval-bridge.js')
  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { signalStore } = await makeStores({ dataDir })
  await persistSignal({
    signalStore,
    runId: p.runId,
    toolCallId: p.toolCallId,
    kind: 'escalation',
    rationale: p.rationale,
  })
  const writer = getWritable<UIMessageChunk>().getWriter()
  try {
    await writer.write({
      type: 'data-signal-created',
      id: `signal-created:${p.runId}:${p.toolCallId}`,
      data: {
        signalId: signalIdFor(p.runId, p.toolCallId, 'escalation'),
        kind: 'escalation',
        toolCallId: p.toolCallId,
        rationale: p.rationale,
      },
    } as unknown as UIMessageChunk)
  } finally {
    writer.releaseLock()
  }
}

// ─────────────────────── helpers ────────────────────────────

function extractText(msg: ModelMessage): string {
  const content = (msg as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: 'text'; text: string } => (p as { type?: string }).type === 'text')
      .map(p => p.text)
      .join('\n')
  }
  return ''
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
