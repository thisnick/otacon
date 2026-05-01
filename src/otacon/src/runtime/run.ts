/**
 * Session runner. Wires:
 *   - workspace + team + (resolved) session id
 *   - sandbox dir (built via storage/session.buildSandbox)
 *   - SessionBus + three subscribers (console, messages persister, events persister)
 *   - just-bash with otacon/otacon-alloc + ReadWriteFs root at workspace
 *   - Pi tools: bash, read_file, write_file, escalate (closure-bound to bus + bash)
 *   - Pi Agent with approval gate + Pi → bus event forwarding
 *   - Loads prior messages.jsonl on resume
 *   - Calls agent.prompt(userMessage) (or agent.continue() for resume)
 *   - On agent_end: writes session.json + last-session.txt
 */
import { Agent } from '@mariozechner/pi-agent-core'
import { getModel } from '@mariozechner/pi-ai'
import type { AgentMessage, AgentTool } from '@mariozechner/pi-agent-core'
import type { Message } from '@mariozechner/pi-ai'
import { ulid } from 'ulid'
import { SessionBus } from './session-bus.js'
import { makeApprovalGate } from '../agents/approval-gate.js'
import { buildSystemPrompt } from '../agents/build-prompt.js'
import { buildBash } from '../sandbox/build.js'
import { makeBashTool } from '../tools/bash.js'
import { makeReadFileTool, makeWriteFileTool } from '../tools/file-ops.js'
import { makeEscalateTool } from '../tools/escalate.js'
import { makeConsolePrinter } from '../persisters/console.js'
import { makeEventsPersister } from '../persisters/events.js'
import { makeMessagesPersister } from '../persisters/messages.js'
import {
  buildSandbox,
  readLastSessionId,
  readMessages,
  readSessionMeta,
  writeLastSessionId,
  writeSessionMeta,
} from '../storage/session.js'
import { workspaceDir } from '../storage/paths.js'
import { readTeam } from '../storage/team.js'
import { readWorkspace } from '../storage/workspace.js'
import type { OtaconEvent, SessionMeta } from '../types.js'

export interface RunOpts {
  dataRoot: string
  workspaceId: string
  teamName: string
  /** Resume mode: 'last' (default) reads last-session.txt; 'new' starts fresh; otherwise the session id to resume. */
  resume: 'last' | 'new' | string
  /** First user message for this run. Forwarded as `agent.prompt(text)`. */
  userMessage: string
  /** Provider id for `getModel(provider, modelId)`. Inferred from team config if absent. */
  modelProvider?: string
  /** Spike: the OtaconClient base URL for the phone. Required if the agent calls otacon. */
  phoneClientBaseUrl?: string
  /** Console printer extras. */
  openScreenshots?: boolean
  /** Bypass the TTY approval prompt. */
  autoApprove?: boolean
  /** Always reject mutating commands (for testing the rejection path). */
  autoReject?: boolean
  /** Optional abort signal — propagated into the agent. */
  signal?: AbortSignal
}

export interface RunResult {
  sessionId: string
  status: SessionMeta['status']
  turnCount: number
  endedAt: number
}

export async function runSession(opts: RunOpts): Promise<RunResult> {
  const ws = await readWorkspace(opts.dataRoot, opts.workspaceId)
  if (!ws) throw new Error(`workspace "${opts.workspaceId}" not found`)
  const team = await readTeam(opts.dataRoot, opts.teamName)
  if (!team) throw new Error(`team "${opts.teamName}" not found`)
  if (team.expectedWorkspaceKind !== ws.kind) {
    throw new Error(`team "${opts.teamName}" expects workspace kind "${team.expectedWorkspaceKind}" but workspace "${ws.id}" is "${ws.kind}"`)
  }

  // Resolve session id.
  let sessionId: string
  let isResume = false
  if (opts.resume === 'new') {
    sessionId = ulid()
  } else if (opts.resume === 'last') {
    const last = await readLastSessionId(opts.dataRoot, opts.workspaceId, opts.teamName)
    if (last) {
      sessionId = last
      isResume = true
    } else {
      sessionId = ulid()
    }
  } else {
    sessionId = opts.resume
    isResume = true
  }

  const agentRole = team.lead
  const leadAgent = team.agents.find(a => a.role === agentRole)
  if (!leadAgent) throw new Error(`team "${opts.teamName}" has no agent matching lead role "${agentRole}"`)

  // Spike model resolution: leadAgent.model is e.g. "claude-sonnet-4-6";
  // the provider defaults to "anthropic" unless overridden. Future task
  // is a richer model spec format.
  const provider = opts.modelProvider ?? 'anthropic'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = getModel(provider as any, leadAgent.model as any)

  const sandboxDir = await buildSandbox(opts.dataRoot, opts.workspaceId, opts.teamName, sessionId)
  const wsRoot = workspaceDir(opts.dataRoot, opts.workspaceId)

  const bus = new SessionBus()
  const consoleSubscriber = makeConsolePrinter({ openScreenshots: opts.openScreenshots })
  const messagesSubscriber = makeMessagesPersister({
    dataRoot: opts.dataRoot, workspaceId: opts.workspaceId, teamName: opts.teamName, sessionId,
  })
  const eventsSubscriber = makeEventsPersister({
    dataRoot: opts.dataRoot, workspaceId: opts.workspaceId, teamName: opts.teamName, sessionId,
  })
  bus.subscribe(consoleSubscriber)
  bus.subscribe(messagesSubscriber)
  bus.subscribe(eventsSubscriber)

  const bash = buildBash({
    dataRoot: opts.dataRoot,
    workspaceId: opts.workspaceId,
    teamName: opts.teamName,
    sessionId,
    workspaceRoot: wsRoot,
    sandboxDir,
    getClientBaseUrl: () => opts.phoneClientBaseUrl ?? null,
    bus,
  })

  const tools: AgentTool<any>[] = [
    makeBashTool({ bash }),
    makeReadFileTool(bash),
    makeWriteFileTool(bash),
    makeEscalateTool({
      dataRoot: opts.dataRoot,
      workspaceId: opts.workspaceId,
      teamName: opts.teamName,
      sessionId,
      bus,
      signal: opts.signal,
    }),
  ]

  const systemPrompt = await buildSystemPrompt({
    dataRoot: opts.dataRoot,
    workspace: ws,
    teamName: opts.teamName,
    agentRole,
  })

  const startedAt = Date.now()
  const meta: SessionMeta = isResume
    ? (await readSessionMeta(opts.dataRoot, opts.workspaceId, opts.teamName, sessionId)) ?? {
        id: sessionId,
        workspace: opts.workspaceId,
        team: opts.teamName,
        agentRole,
        modelProvider: provider,
        modelId: leadAgent.model,
        startedAt,
        endedAt: null,
        status: 'running',
      }
    : {
        id: sessionId,
        workspace: opts.workspaceId,
        team: opts.teamName,
        agentRole,
        modelProvider: provider,
        modelId: leadAgent.model,
        startedAt,
        endedAt: null,
        status: 'running',
      }
  meta.status = 'running'
  meta.endedAt = null
  await writeSessionMeta(opts.dataRoot, opts.workspaceId, opts.teamName, meta)

  const priorMessages = isResume
    ? await readMessages(opts.dataRoot, opts.workspaceId, opts.teamName, sessionId)
    : []

  // Print run header now that everything is wired.
  process.stdout.write(`▶ run ${sessionId} (${ws.id} / ${opts.teamName} / ${leadAgent.model})\n`)
  bus.emit({ kind: 'system_set', prompt: systemPrompt, ts: Date.now() })

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: 'off',
      tools,
      messages: priorMessages as AgentMessage[],
    },
    convertToLlm: (messages) => messages.filter(isLlmMessage) as Message[],
    beforeToolCall: makeApprovalGate({
      autoApprove: opts.autoApprove,
      autoReject: opts.autoReject,
    }),
  })

  agent.subscribe((piEvent) => {
    bus.emit({ kind: 'pi', event: piEvent, ts: Date.now() })
  })

  // Echo the user message into the bus (pre-agent.prompt) so the console
  // printer surfaces "[user] ..." in the right place.
  bus.emit({ kind: 'user_message', text: opts.userMessage, ts: Date.now() })

  let turnCount = 0
  agent.subscribe((piEvent) => {
    if (piEvent.type === 'turn_end') turnCount++
  })

  let runStatus: SessionMeta['status'] = 'completed'
  let runError: string | null = null
  try {
    if (isResume && priorMessages.length > 0) {
      // Append the new user message to the existing transcript and call
      // agent.prompt — this both adds the message and starts a turn.
      await agent.prompt(opts.userMessage)
    } else {
      await agent.prompt(opts.userMessage)
    }
    await agent.waitForIdle()
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e)
    runStatus = 'error'
  }

  const endedAt = Date.now()
  const finalMeta: SessionMeta = {
    ...meta,
    status: runStatus,
    endedAt,
    error: runError,
  }
  await writeSessionMeta(opts.dataRoot, opts.workspaceId, opts.teamName, finalMeta)
  // Update last-session.txt only for default ("last") and "new" resumes.
  // Explicit `--session <id>` is "look at history" — leave the resume
  // pointer alone so the next default invocation continues whatever the
  // user was previously working on, not the historical session they just
  // peeked at.
  if (opts.resume === 'last' || opts.resume === 'new') {
    await writeLastSessionId(opts.dataRoot, opts.workspaceId, opts.teamName, sessionId)
  }

  return {
    sessionId,
    status: runStatus,
    turnCount,
    endedAt,
  }
}

function isLlmMessage(m: AgentMessage): m is Message {
  return (
    m && typeof m === 'object' &&
    'role' in m &&
    (m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult')
  )
}
