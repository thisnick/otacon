/**
 * `signals` group — HTTP-backed CLI subcommands (P3-I).
 *
 *   signals list [--status=] [--run-id=] [--json]
 *   signals resolve <signal_id> <decision> [--message=]
 */
import { makeApiClient } from './api-client.js'

interface Signal {
  id: string
  runId: string
  kind: string
  status: string
  toolCallId?: string | null
  command?: string | null
  rationale?: string | null
  createdAt: number
  resolvedAt?: number | null
  decision?: string | null
}

export async function signalsListCommand(opts: {
  status?: string
  runId?: string
  json?: boolean
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const body = await api.get<{ signals: Signal[] }>('/api/v1/signals', {
    query: { status: opts.status, run_id: opts.runId },
  })
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2))
    return
  }
  if (body.signals.length === 0) {
    console.log('(no signals)')
    return
  }
  for (const s of body.signals) {
    const ts = new Date(s.createdAt).toISOString().slice(0, 19).replace('T', ' ')
    const cmd = s.command ?? '(no command)'
    console.log(`${s.id}  ${s.status.padEnd(9)}  run=${s.runId}  ${ts}  ${cmd}`)
    if (s.rationale) console.log(`    rationale: ${s.rationale}`)
  }
}

export async function signalsResolveCommand(opts: {
  signalId: string
  decision: 'approve' | 'reject' | 'skip'
  message?: string
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const body = await api.post<{ signal: { status: string; decision: string | null } }>(
    `/api/v1/signals/${encodeURIComponent(opts.signalId)}/resolve`,
    { body: { decision: opts.decision, message: opts.message } },
  )
  console.log(
    `signal ${opts.signalId}: ${body.signal.status}` +
      (body.signal.decision ? ` (decision=${body.signal.decision})` : ''),
  )
}
