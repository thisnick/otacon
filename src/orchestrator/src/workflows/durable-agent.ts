/**
 * Durable agent: wraps DurableAgent from @workflow/ai in a continuation loop
 * with conversation persistence.
 *
 * Phase A: runs in-process with blob-backed conversation persistence.
 * Sleep is a real setTimeout. No workflow SDK durability yet (requires build step).
 * The API surface is designed so Phase B can add "use workflow" + workflow runtime.
 */
import { DurableAgent } from '@workflow/ai/agent'
import { tool } from 'ai'
import { gateway } from '@ai-sdk/gateway'
import { z } from 'zod'
import * as path from 'node:path'
import type { Bash } from 'just-bash'
import type { ModelMessage, UIMessageChunk } from 'ai'
import type { BlobStore } from '../storage/blob.js'
import type { Db } from '../db/client.js'
import { loadConversation, saveConversation } from '../storage/conversation.js'
import { isMutating } from '../sandbox/build.js'
import { requestApproval } from '../approval/prompt.js'
import type { OtaconClient } from 'otacon-cli/client'
import { activityLog, agentSignals } from '../db/schema.js'
import { ulid } from 'ulid'

export interface DurableAgentConfig {
  conversationId: string
  accountId: string
  /** Hidden from the agent; surfaced only for approval log/diagnostics. */
  phoneId: string | null
  /** Conversation's blob path (relative to blobRoot), e.g. "conversations/<id>". */
  conversationBlobPath: string
  /**
   * Absolute filesystem root for blob storage (e.g. ".orchestrator-data/blobs").
   * Used to derive the absolute trace dir per bash invocation. Without this,
   * relative paths resolve against the orchestrator process cwd instead of
   * the blob storage root.
   */
  blobRoot: string
  model: string
  systemPrompt: string
  bash: Bash
  blobStore: BlobStore
  db: Db
  client: OtaconClient | null
  initialPrompt?: string
}

/**
 * Sleep for a given duration string (e.g. "10s", "5m", "3h") or until a date.
 * Phase A: real setTimeout. Phase B: workflow SDK sleep().
 */
function parseDuration(until: string): number {
  // Try ISO date first
  const parsed = Date.parse(until)
  if (!isNaN(parsed)) {
    return Math.max(0, parsed - Date.now())
  }
  // Parse duration string
  const match = until.match(/^(\d+)(ms|s|m|h|d)$/)
  if (!match) return 10000 // fallback 10s
  const [, num, unit] = match
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }
  return parseInt(num) * (multipliers[unit] ?? 1000)
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function runDurableAgent(config: DurableAgentConfig) {
  const {
    conversationId,
    accountId,
    phoneId,
    conversationBlobPath,
    blobRoot,
    model,
    systemPrompt,
    bash,
    blobStore,
    db,
    client,
    initialPrompt,
  } = config

  const sessionId = ulid()

  // Build tools
  const agentTools = {
    bash: tool({
      description:
        'Run a bash command in the sandbox. Available commands include `otacon` for phone control and `otacon-alloc` for phone lease management, plus standard utilities (cat, echo, ls, grep). Run `otacon-alloc provision` before any otacon command. See system prompt for the full command reference.',
      inputSchema: z.object({
        command: z.string().describe('The bash command to run'),
        rationale: z.string().describe('Why you are running this command'),
      }),
      execute: async ({ command, rationale }, ctx: any) => {
        // Check if approval needed
        if (isMutating(command)) {
          const signalId = ulid()
          const decision = await requestApproval(
            { signalId, command, rationale, accountId, phoneId: phoneId ?? 'unknown' },
            client,
          )

          if (decision === 'reject') {
            return 'Action rejected by approver.'
          }
          if (decision === 'skip') {
            return 'Session skipped by approver.'
          }
        }

        // Per-tool-call trace dir: every mutating otacon command will save
        // an annotated screenshot under this dir. Read by CLI shared modules.
        // Build an ABSOLUTE path so `_trace.ts`'s plain `fs.mkdir/writeFile`
        // calls land inside blob storage instead of resolving against
        // `process.cwd()` (which would put them at src/orchestrator/conversations/...).
        const toolCallId = ctx?.toolCallId ?? ulid()
        const traceDir = path.resolve(blobRoot, conversationBlobPath, 'traces', toolCallId)

        const result = await bash.exec(command, {
          env: { OTACON_TRACE_DIR: traceDir },
        })

        // Log to activity_log
        const verb = command.trim().split(/\s+/)[0]
        try {
          await db.insert(activityLog).values({
            id: ulid(),
            conversationId,
            sessionId,
            actionType: verb === 'otacon' ? `otacon:${command.trim().split(/\s+/)[1] ?? 'unknown'}` : `bash:${verb}`,
            target: command,
            details: {
              rationale,
              exitCode: result.exitCode,
              stdout: result.stdout.slice(0, 500),
              stderr: result.stderr.slice(0, 500),
            },
          })
        } catch {}

        // Format output for the agent
        let output = ''
        if (result.stdout) output += result.stdout
        if (result.stderr) output += (output ? '\n' : '') + `[stderr] ${result.stderr}`
        if (result.exitCode !== 0) output += (output ? '\n' : '') + `[exit code: ${result.exitCode}]`
        return output || '(no output)'
      },
    }),

    sleep_until: tool({
      description:
        'Suspend the agent for a duration. Examples: "10s", "5m", "3h", "2026-04-28T09:00:00Z". The workflow truly suspends — no compute consumed during long sleeps.',
      inputSchema: z.object({
        until: z.string().describe('Duration string (e.g. "10s", "3h") or ISO 8601 datetime'),
        reason: z.string().describe('Why you are sleeping'),
      }),
      execute: async ({ until, reason }) => {
        const ms = parseDuration(until)
        console.log(`[sleep] ${reason} — sleeping for ${until} (${ms}ms)`)

        try {
          await db.insert(activityLog).values({
            id: ulid(),
            conversationId,
            sessionId,
            actionType: 'sleep',
            target: until,
            details: { reason, durationMs: ms },
          })
        } catch {}

        await sleepMs(ms)
        return `Resumed at ${new Date().toISOString()}`
      },
    }),

    escalate: tool({
      description:
        'Pause and ask the user for help. Use when stuck, unsure, or need guidance.',
      inputSchema: z.object({
        issue: z.string().describe('Description of the issue or question'),
      }),
      execute: async ({ issue }) => {
        const signalId = ulid()

        try {
          await db.insert(agentSignals).values({
            id: signalId,
            conversationId,
            signalType: 'escalation',
            hookToken: `esc:${accountId}:${signalId}`,
            status: 'pending',
            payload: { issue },
          })
        } catch {}

        console.log(`\n[ESCALATION] ${issue}`)
        console.log(`Signal ID: ${signalId}`)

        // For Phase A: use the approval mechanism (file-based or stdin)
        const decision = await requestApproval(
          {
            signalId,
            command: `[escalation] ${issue}`,
            rationale: issue,
            accountId,
            phoneId: phoneId ?? 'unknown',
          },
          null, // no screenshot for escalations
        )

        return decision === 'approve'
          ? 'User approved. Continue with your plan.'
          : 'User rejected. Re-evaluate your approach.'
      },
    }),
  }

  // Create the durable agent
  const modelInstance = gateway(model as any)
  const agent = new DurableAgent({
    model: () => Promise.resolve(modelInstance),
    instructions: systemPrompt,
    tools: agentTools,
  })

  // Load existing conversation
  let messages = await loadConversation(blobStore, conversationId)

  // Add initial prompt or continuation nudge
  if (initialPrompt) {
    messages.push({ role: 'user', content: initialPrompt } as ModelMessage)
  } else if (messages.length === 0) {
    messages.push({ role: 'user', content: 'Begin your work. Check your instructions and proceed.' } as ModelMessage)
  }

  // Create a writable stream that logs assistant output to stdout
  const writable = new WritableStream<UIMessageChunk>({
    write(chunk: any) {
      const type = chunk.type ?? 'unknown'
      if (type === 'text-delta') {
        process.stdout.write(chunk.textDelta ?? '')
      } else if (type === 'reasoning-delta') {
        // Show reasoning in dim text
        process.stdout.write(`\x1b[2m${chunk.delta ?? ''}\x1b[0m`)
      } else if (type === 'tool-call') {
        console.log(`\n[tool] ${chunk.toolName}(${JSON.stringify(chunk.args ?? chunk.input ?? {}).slice(0, 200)})`)
      } else if (type === 'tool-result') {
        const output = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output)
        console.log(`[tool result] ${output.slice(0, 300)}`)
      }
      // Ignore: start, finish, text-start, text-end, start-step, finish-step, reasoning-start, reasoning-end
    },
  })

  // Continuation loop
  const MAX_TURNS = 50
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    console.log(`\n[agent] Turn ${turn + 1}`)

    const result = await agent.stream({
      messages,
      writable,
      preventClose: turn < MAX_TURNS - 1, // keep stream open between turns
    })

    messages = result.messages

    // Print the last assistant message text (in case streaming didn't show it)
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role === 'assistant') {
      const parts = Array.isArray(lastMsg.content) ? lastMsg.content : [{ type: 'text', text: lastMsg.content }]
      for (const part of parts) {
        if ((part as any).type === 'text' && (part as any).text) {
          console.log(`\n${(part as any).text}`)
        }
      }
    }

    // Persist conversation after each turn
    await saveConversation(blobStore, conversationId, messages)
    console.log(`\n[agent] Conversation saved (${messages.length} messages)`)

    // Check if the agent naturally stopped
    const lastStep = result.steps[result.steps.length - 1]
    if (lastStep?.finishReason === 'stop') {
      console.log('[agent] Agent stopped naturally')
      break
    }
  }

  console.log('[agent] Agent workflow complete')
  return messages
}
