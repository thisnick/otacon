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
    // Pass the model identifier as a STRING. @workflow/ai resolves it via
    // the Vercel AI Gateway internally inside its own steps. Passing a
    // raw factory function fails serialization with `DevalueError: Cannot
    // stringify a function` when Workflow SDK persists step arguments.
    model: args.model,
    instructions: args.systemPrompt,
    tools: buildTools({ runId: args.runId, accountId: args.accountId }),
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
        // Some models emit tool-call names like "otacon-alloc" or
        // "otacon" directly even though the only tool we expose is
        // `bash`. Repair the call by routing it through bash with the
        // model's args reconstructed as a command string.
        experimental_repairToolCall: async ({ toolCall }) => {
          const fabricated = toolCall.toolName
          if (fabricated === 'bash' || fabricated === 'sleep_until' || fabricated === 'escalate') {
            return null
          }
          const input = parseRepairInput(toolCall.input)
          let command = fabricated
          if (input.command) command = `${fabricated} ${input.command}`.trim()
          else if (input.subcommand) command = `${fabricated} ${input.subcommand}`.trim()
          else if (input.args && Array.isArray(input.args)) command = `${fabricated} ${input.args.join(' ')}`.trim()
          const rationale = input.rationale ?? `repaired tool-call (model invented "${fabricated}")`
          return {
            ...toolCall,
            toolName: 'bash',
            input: JSON.stringify({ command, rationale }),
          }
        },
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
    const error = errorMessage(e)
    await markRunStatusStep({ runId: args.runId, status: 'failed', error })
    await emitRunFailedStep({ runId: args.runId, error })
    return { finalText, turnCount: messages.length, status: 'failed' }
  }

  await markRunStatusStep({
    runId: args.runId,
    status: 'completed',
    finalText,
    turnCount: messages.length,
  })
  await emitRunCompletedStep({
    runId: args.runId,
    finalText,
    turnCount: messages.length,
  })

  return { finalText, turnCount: messages.length, status: 'completed' }
}

/**
 * Persist run status + final text/turn count to RunStore. Run as a step
 * so the workflow body stays deterministic.
 */
async function markRunStatusStep(p: {
  runId: string
  status: 'completed' | 'failed' | 'cancelled'
  finalText?: string
  turnCount?: number
  error?: string
}): Promise<void> {
  'use step'
  const { makeStores } = await import('../src/storage/factory.js')
  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { runStore } = await makeStores({ dataDir })
  await runStore.updateStatus(p.runId, p.status, {
    finalText: p.finalText ?? null,
    turnCount: p.turnCount ?? 0,
    error: p.error ?? null,
  })
}

// ────────────────────────── tools ───────────────────────────

interface ToolFactoryCtx {
  runId: string
  accountId: string
}

function buildTools(ctx: ToolFactoryCtx) {
  return {
    bash: bashTool(ctx),
    sleep_until: sleepUntilTool(),
    escalate: escalateTool(ctx),
  }
}

/**
 * Suspend the agent for a duration or until a date. Workflow SDK's
 * `sleep()` takes a duration string (e.g. "10s", "5m") OR a Date OR a
 * raw ms number — we accept either string or ISO timestamp from the
 * model and dispatch.
 */
function sleepUntilTool() {
  return tool({
    description:
      'Suspend the agent for a duration. Examples: "10s", "5m", "3h", "2026-04-28T09:00:00Z". The workflow truly suspends — no compute consumed during long sleeps.',
    inputSchema: z.object({
      until: z.string().describe('Duration string (e.g. "10s", "3h") or ISO 8601 datetime'),
      reason: z.string().describe('Why you are sleeping'),
    }),
    execute: async ({ until, reason }) => {
      const { sleep } = await import('workflow')
      const asDate = Date.parse(until)
      if (!Number.isNaN(asDate)) {
        await sleep(new Date(asDate))
      } else {
        await sleep(until as never)
      }
      return `Resumed: ${reason}`
    },
  })
}

/**
 * Bash tool. Asks for human approval (when the command mutates phone
 * state), then runs the command via the sandbox and returns its output.
 *
 * Notably: NO `'use step'` here. The execute function runs in workflow
 * context so it can acquire a hook via `approvalHook.create()`. Inside it
 * we still call `'use step'` helpers (`persistSignal*Step`,
 * `emitSignalResolvedStep`, `execBashStep`) for non-deterministic IO.
 */
function bashTool(ctx: ToolFactoryCtx) {
  return tool({
    description:
      'Run a bash command in the sandbox. Available commands include `otacon` for phone control and `otacon-alloc` for phone lease management, plus standard utilities (cat, echo, ls, grep). Run `otacon-alloc provision` before any otacon command. See system prompt for the full command reference.',
    inputSchema: z.object({
      command: z.string().describe('The bash command to run.'),
      rationale: z.string().describe('Why you are running this command.'),
    }),
    execute: async ({ command, rationale }, opts: { toolCallId: string }) => {
      const toolCallId = opts.toolCallId

      // Gate mutating phone commands on human approval. Read-only verbs
      // (info, snapshot, screenshot, etc.) skip the gate and run directly.
      if (await isMutatingStep(command)) {
        const token = approvalToken(ctx.runId, toolCallId)

        // IMPORTANT: hook creation must precede the data-signal-created
        // chunk emission. Otherwise a CLI/UI that races on the chunk
        // could POST resolve before world-local has the hook token
        // indexed, hitting HookNotFoundError.
        const hook = approvalHook.create({ token })

        // Persist signal metadata + emit data-signal-created (step). Now
        // that the hook is registered, external resolvers can find it
        // via SignalStore.getByHookToken.
        await persistSignalForBashStep({
          runId: ctx.runId,
          toolCallId,
          command,
          rationale,
        })

        // SUSPEND. Workflow durably waits here.
        const { decision, message } = await hook

        await emitSignalResolvedStep({
          runId: ctx.runId,
          toolCallId,
          kind: 'approval',
          decision,
          message: message ?? null,
        })

        if (decision === 'reject') return `Action rejected: ${message ?? 'no reason given'}`
        if (decision === 'skip') return `Session skipped by approver: ${message ?? 'no reason given'}`
      }

      // Exec — delegated to a step so non-deterministic IO stays out of
      // the workflow body. The step caches the Bash instance per runId.
      const result = await execBashStep({
        runId: ctx.runId,
        accountId: ctx.accountId,
        toolCallId,
        command,
        rationale,
      })
      let output = ''
      if (result.stdout) output += result.stdout
      if (result.stderr) output += (output ? '\n' : '') + `[stderr] ${result.stderr}`
      if (result.exitCode !== 0) output += (output ? '\n' : '') + `[exit code: ${result.exitCode}]`
      return output || '(no output)'
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

// ─────────── exec step (per-runId sandbox cache) ───────────

/**
 * Check whether a `bash` command requires approval. The check itself is
 * deterministic, but it has to run in a step because `otaconRegistry`
 * lives in `otacon-cli` which isn't workflow-VM-loadable.
 */
async function isMutatingStep(command: string): Promise<boolean> {
  'use step'
  const { isMutating } = await import('../src/sandbox/mutating.js')
  return isMutating(command)
}

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Run a single bash command in the sandbox. Builds (or reuses) a per-run
 * sandbox cached by `runId` — see notes inside.
 *
 * Returns stdout/stderr/exitCode plain strings + numbers (serializable
 * across the step boundary). The trace dir is set to
 * `runs/{runId}/traces/{toolCallId}` (absolute path under the blob root)
 * so the otacon CLI's `_trace.ts` writes its annotated screenshot under
 * the run's artifacts directory.
 *
 * The legacy `phone_allocations` table FK-references `conversations.id`,
 * so this step also upserts a stub conversations row keyed by `runId`
 * before invoking the sandbox. That row goes away when allocations
 * migrate to FS (planned commit 9).
 */
async function execBashStep(p: {
  runId: string
  accountId: string
  toolCallId: string
  command: string
  rationale: string
}): Promise<ExecResult> {
  'use step'
  const { getSandbox, blobRoot } = await import('../src/run-executor/sandbox-cache.js')
  const path = await import('node:path')
  const bash = await getSandbox({ runId: p.runId, accountId: p.accountId })
  const traceDir = path.resolve(blobRoot, 'runs', p.runId, 'traces', p.toolCallId)
  const result = await bash.exec(p.command, {
    env: { OTACON_TRACE_DIR: traceDir },
  })
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
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

interface RepairInput {
  command?: string
  subcommand?: string
  args?: unknown[]
  rationale?: string
}

function parseRepairInput(input: unknown): RepairInput {
  if (!input) return {}
  if (typeof input === 'string') {
    try { return JSON.parse(input) as RepairInput } catch { return { command: input } }
  }
  if (typeof input === 'object') return input as RepairInput
  return {}
}
