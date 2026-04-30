/**
 * `runs` group — HTTP-backed CLI subcommands (P3-I).
 *
 * Uses the orchestrator HTTP API; assumes `pnpm orchestrator serve` (or
 * the deployed binary) is running at the configured `ORCHESTRATOR_URL`.
 *
 * Subcommands:
 *   runs list [--account=] [--status=] [--team=] [--limit=] [--json]
 *   runs show <run_id> [--json]
 *   runs prompt <run_id>             # plaintext markdown
 *   runs messages <run_id> [--json]  # full UIMessage[] snapshot
 *   runs cancel <run_id>
 *   runs message <run_id> <text>     # POST /messages — enqueue user message
 */
import { makeApiClient } from './api-client.js'

interface RunSummary {
  id: string
  account: string
  team: string
  status: string
  startedAt: number
  completedAt?: number | null
}

interface Run extends RunSummary {
  workflowRunId?: string | null
  agentRole?: string
  model?: string
  finalText?: string | null
  turnCount?: number
  error?: string | null
}

export async function runsListCommand(opts: {
  account?: string
  status?: string
  team?: string
  limit?: number
  json?: boolean
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const body = await api.get<{ runs: RunSummary[] }>('/api/v1/runs', {
    query: {
      account: opts.account,
      status: opts.status,
      team: opts.team,
      limit: opts.limit,
    },
  })
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2))
    return
  }
  printRunTable(body.runs)
}

export async function runsShowCommand(opts: {
  runId: string
  json?: boolean
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const run = await api.get<Run>(`/api/v1/runs/${encodeURIComponent(opts.runId)}`)
  if (opts.json) {
    console.log(JSON.stringify(run, null, 2))
    return
  }
  console.log(`id          ${run.id}`)
  console.log(`workflow    ${run.workflowRunId ?? '(not yet)'}`)
  console.log(`account     ${run.account}`)
  console.log(`team        ${run.team}`)
  console.log(`agentRole   ${run.agentRole ?? ''}`)
  console.log(`model       ${run.model ?? ''}`)
  console.log(`status      ${run.status}`)
  console.log(`startedAt   ${new Date(run.startedAt).toISOString()}`)
  if (run.completedAt) console.log(`completedAt ${new Date(run.completedAt).toISOString()}`)
  if (typeof run.turnCount === 'number') console.log(`turnCount   ${run.turnCount}`)
  if (run.error) console.log(`error       ${run.error}`)
  if (run.finalText) {
    console.log('\n── final text ──')
    console.log(run.finalText)
  }
}

export async function runsPromptCommand(opts: {
  runId: string
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const text = await api.get<string>(
    `/api/v1/runs/${encodeURIComponent(opts.runId)}/prompt`,
    { accept: 'text/markdown' },
  )
  process.stdout.write(typeof text === 'string' ? text : String(text))
}

export async function runsMessagesCommand(opts: {
  runId: string
  json?: boolean
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const body = await api.get<{ messages: unknown[] }>(
    `/api/v1/runs/${encodeURIComponent(opts.runId)}/messages`,
  )
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2))
    return
  }
  // Plain rendering — one block per message. UIMessage shape from AI SDK
  // is `{role, id, parts: [{type, text?, ...}]}`.
  for (const msg of body.messages as Array<{ role?: string; id?: string; parts?: Array<{ type?: string; text?: string }> }>) {
    const role = msg.role ?? '?'
    const text = (msg.parts ?? [])
      .map(p => (p.type === 'text' ? p.text ?? '' : `[${p.type ?? '?'}]`))
      .join('')
    console.log(`── ${role.toUpperCase()} (${msg.id ?? ''}) ──`)
    console.log(text)
    console.log()
  }
}

export async function runsCancelCommand(opts: {
  runId: string
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const body = await api.post<{ run: { status: string } }>(
    `/api/v1/runs/${encodeURIComponent(opts.runId)}/cancel`,
  )
  console.log(`run ${opts.runId}: ${body.run.status}`)
}

export async function runsMessageCommand(opts: {
  runId: string
  content: string
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const body = await api.post<{ message: { id: string; ts: number } }>(
    `/api/v1/runs/${encodeURIComponent(opts.runId)}/messages`,
    { body: { content: opts.content } },
  )
  console.log(`enqueued message ${body.message.id} at ${new Date(body.message.ts).toISOString()}`)
}

// ─────────── table renderer (run-list-table) ───────────

function printRunTable(runs: RunSummary[]): void {
  if (runs.length === 0) {
    console.log('(no runs)')
    return
  }
  const cols = ['ID', 'ACCOUNT', 'TEAM', 'STATUS', 'STARTED']
  const rows = runs.map(r => [
    r.id,
    r.account,
    r.team,
    r.status,
    new Date(r.startedAt).toISOString().slice(0, 19).replace('T', ' '),
  ])
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...rows.map(r => r[i].length)),
  )
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  console.log(fmt(cols))
  console.log(fmt(widths.map(w => '─'.repeat(w))))
  for (const r of rows) console.log(fmt(r))
}
