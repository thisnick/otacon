/**
 * `inspect runs` and `inspect run <id>` — orchestrator-v2 read-only views
 * over `RunStore` + the chunk stream owned by `@workflow/world-local`.
 *
 * Replaces the legacy `inspect conversations` / `inspect conversation
 * <id>` commands once the Drizzle path is removed (commit 10). Both
 * coexist for now.
 *
 * The stream replay reuses Workflow SDK runtime state — that means the
 * orchestrator's `setWorld(createLocalWorld(...))` has to run once
 * before we can call `getRun(workflowRunId).getReadable()`. The Nitro
 * server's `server/plugins/world.ts` does this at boot; for one-shot
 * CLI invocations we mount the same world inline here.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { readUIMessageStream } from 'ai'
import type { UIMessage, UIMessageChunk } from 'ai'
import { setWorld, getRun } from '@workflow/core/runtime'
import { createLocalWorld } from '@workflow/world-local'
import { makeStores } from '../storage/factory.js'
import type { Run, RunStatus } from '../storage/types.js'

interface InspectRunsOpts {
  account?: string
  status?: RunStatus
  limit?: number
  json?: boolean
  dataDir?: string
}

/** `inspect runs [--account <id>] [--status <s>] [--limit N] [--json]` */
export async function inspectRunsCommand(opts: InspectRunsOpts): Promise<void> {
  const dataDir = opts.dataDir ?? process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { runStore } = await makeStores({ dataDir })
  const runs = await runStore.list({
    account: opts.account,
    status: opts.status,
    limit: opts.limit ?? 50,
  })

  if (opts.json) {
    process.stdout.write(JSON.stringify(runs, null, 2) + '\n')
    return
  }

  if (runs.length === 0) {
    console.log('(no runs)')
    return
  }

  // Column-aligned table. Newest first (RunStore.list already sorts).
  console.log('ID                                Account              Team                          Status      Turns  Started               Duration')
  console.log('─'.repeat(140))
  for (const r of runs) {
    const id = r.id.padEnd(32)
    const account = (r.account ?? '').padEnd(20)
    const team = (r.team ?? '').padEnd(30)
    const status = r.status.padEnd(11)
    const turns = String(r.turnCount).padStart(5)
    const started = formatTs(r.startedAt).padEnd(20)
    const duration = formatDuration(r.startedAt, r.completedAt)
    console.log(`${id}  ${account} ${team} ${status} ${turns}  ${started}  ${duration}`)
  }
}

interface InspectRunOpts {
  runId: string
  dataDir?: string
  /** If true, print the JSON-shaped UIMessage[] instead of a markdown report. */
  json?: boolean
}

/** `inspect run <id>` */
export async function inspectRunCommand(opts: InspectRunOpts): Promise<void> {
  const dataDir = opts.dataDir ?? process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { runStore, layout } = await makeStores({ dataDir })
  const run = await runStore.get(opts.runId)
  if (!run) {
    console.error(`run "${opts.runId}" not found`)
    process.exit(1)
  }

  // Mount the same world the server uses, so getRun + getReadable work
  // for replay against the on-disk persisted chunks.
  const workflowDir = path.resolve(dataDir, 'workflow')
  const world = createLocalWorld({ dataDir: workflowDir })
  setWorld(world)
  await world.start?.()

  let messages: UIMessage[] = []
  let replayError: string | null = null
  if (run.workflowRunId) {
    try {
      const wfRun = getRun<unknown>(run.workflowRunId)
      const exists = await wfRun.exists
      if (exists) {
        const readable = wfRun.getReadable<UIMessageChunk>({ startIndex: 0 })
        for await (const m of readUIMessageStream<UIMessage>({ stream: readable })) {
          messages.push(m)
        }
      } else {
        replayError = `workflow run ${run.workflowRunId} not found in world-local`
      }
    } catch (e) {
      replayError = e instanceof Error ? e.message : String(e)
    }
  } else {
    replayError = 'run has no workflowRunId — workflow may not have started'
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ run, messages, replayError }, null, 2) + '\n')
    return
  }

  // Markdown report: header + prompt link + per-message sections.
  const lines: string[] = []
  lines.push(`# Run: ${run.id}`)
  lines.push('')
  lines.push(`**Account:** ${run.account}`)
  lines.push(`**Team:** ${run.team}`)
  lines.push(`**Agent:** ${run.agentRole}`)
  lines.push(`**Model:** ${run.model}`)
  lines.push(`**Status:** ${run.status}${run.error ? ` — ${run.error}` : ''}`)
  lines.push(`**Started:** ${formatTs(run.startedAt)}`)
  if (run.completedAt) {
    lines.push(`**Completed:** ${formatTs(run.completedAt)}`)
    lines.push(`**Duration:** ${formatDuration(run.startedAt, run.completedAt)}`)
  }
  lines.push(`**Turns:** ${run.turnCount}`)
  lines.push(`**Workflow run:** \`${run.workflowRunId ?? '(none)'}\``)
  if (run.promptSnapshotPath) {
    lines.push(`**Prompt snapshot:** \`${run.promptSnapshotPath}\``)
  }
  if (run.initialPrompt) {
    lines.push('')
    lines.push('**Initial prompt:**')
    lines.push('')
    for (const l of run.initialPrompt.split('\n')) lines.push(`> ${l}`)
  }
  if (run.finalText) {
    lines.push('')
    lines.push('**Final assistant text:**')
    lines.push('')
    for (const l of run.finalText.split('\n')) lines.push(`> ${l}`)
  }
  lines.push('')

  if (replayError) {
    lines.push(`> Stream replay unavailable: ${replayError}`)
    lines.push('')
  } else {
    lines.push(`## Conversation (${messages.length} messages)`)
    lines.push('')
    for (const msg of messages) {
      lines.push(`### ${msg.role}`)
      lines.push('')
      for (const part of msg.parts) {
        renderPart(part, lines)
      }
      lines.push('')
    }
  }

  // Append a list of trace artifacts under runs/{id}/traces/, if any.
  const tracesDir = path.join(layout.runsDir, run.id, 'traces')
  const traces = await listDir(tracesDir)
  if (traces.length > 0) {
    lines.push(`## Trace artifacts (${traces.length} tool calls)`)
    lines.push('')
    for (const tcid of traces) {
      lines.push(`- \`${tcid}\``)
      const files = await listDir(path.join(tracesDir, tcid))
      for (const f of files) {
        lines.push(`  - \`runs/${run.id}/traces/${tcid}/${f}\``)
      }
    }
    lines.push('')
  }

  // Signals
  const signalsDir = path.join(layout.runsDir, run.id, 'signals')
  const signals = await listDir(signalsDir)
  if (signals.length > 0) {
    lines.push(`## Signals (${signals.length})`)
    lines.push('')
    for (const f of signals.filter(f => f.endsWith('.json'))) {
      lines.push(`- \`runs/${run.id}/signals/${f}\``)
    }
    lines.push('')
  }

  process.stdout.write(lines.join('\n'))
}

interface InspectRunPromptOpts {
  runId: string
  dataDir?: string
}

/** `inspect run-prompt <id>` — print the snapshotted system prompt. */
export async function inspectRunPromptCommand(opts: InspectRunPromptOpts): Promise<void> {
  const dataDir = opts.dataDir ?? process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { runStore } = await makeStores({ dataDir })
  const text = await runStore.getPromptSnapshot(opts.runId)
  if (text === null) {
    console.error(`run "${opts.runId}" has no prompt snapshot`)
    process.exit(1)
  }
  process.stdout.write(text)
}

function formatTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

function formatDuration(startedAt: number, completedAt: number | null): string {
  if (!completedAt) return '—'
  const seconds = Math.max(0, Math.round((completedAt - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort()
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
}

function renderPart(part: { type: string } & Record<string, unknown>, lines: string[]): void {
  switch (part.type) {
    case 'text': {
      const text = (part as { text?: string }).text ?? ''
      if (text) lines.push(text)
      lines.push('')
      return
    }
    case 'reasoning': {
      const text = (part as { text?: string }).text ?? ''
      if (text) {
        lines.push('<details><summary>Reasoning</summary>')
        lines.push('')
        lines.push(text)
        lines.push('')
        lines.push('</details>')
        lines.push('')
      }
      return
    }
    default:
      // tool-* parts and any custom data-* parts get a generic rendering
      if (part.type.startsWith('tool-') || part.type.startsWith('data-')) {
        lines.push(`*${part.type}*: \`${JSON.stringify(extractToolish(part)).slice(0, 300)}\``)
        lines.push('')
      }
  }
}

function extractToolish(part: Record<string, unknown>): unknown {
  // Trim the noisy fields for compact output
  const out: Record<string, unknown> = {}
  if (part.toolName) out.toolName = part.toolName
  if (part.toolCallId) out.toolCallId = part.toolCallId
  if (part.input !== undefined) out.input = part.input
  if (part.output !== undefined) out.output = part.output
  if (part.state) out.state = part.state
  if (part.data !== undefined) out.data = part.data
  return Object.keys(out).length > 0 ? out : part
}

// Re-export Run type for command typings if needed externally.
export type { Run, RunStatus }
