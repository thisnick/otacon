/**
 * Console event printer — translates OtaconEvent into terminal output.
 *
 * Phase-1 spike: simple text. No inline images. Pass `--open-screenshots`
 * to the CLI runner to also `open <annotated.png>` per phone-action.
 *
 * Output dialect:
 *
 *   ▶ run 01J... (xhs:test / social-media-engagement / claude-sonnet-4-6)
 *   [user] do thing
 *   [assistant] I'll start by ...
 *   ┌ bash$ otacon tap e5
 *   └ exit 0
 *   📷 phone_action: otacon tap e5  (exit 0)
 *      before:    .../traces/abc/before.png
 *      annotated: .../traces/abc/annotated.png
 *      after:     .../traces/abc/after.png
 *   [assistant] Home feed shows ...
 *   ■ done in 12.3s, 8 turns
 */
import { spawn } from 'node:child_process'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { OtaconEvent } from '../types.js'
import type { Listener } from '../runtime/session-bus.js'

export interface ConsolePrinterOpts {
  /** When true, spawn `open <annotated.png>` for each phone-action. */
  openScreenshots?: boolean
  /** Stream to write to. Defaults to process.stdout. */
  out?: NodeJS.WritableStream
  /** Stream to write errors to. Defaults to process.stderr. */
  err?: NodeJS.WritableStream
}

export function makeConsolePrinter(opts: ConsolePrinterOpts = {}): Listener {
  const out = opts.out ?? process.stdout
  const err = opts.err ?? process.stderr
  const open = opts.openScreenshots ?? false
  let turnCount = 0
  let runStartTs: number | null = null

  return (event: OtaconEvent) => {
    switch (event.kind) {
      case 'system_set':
        // First line of run — printed by run.ts before agent.prompt; keep
        // quiet here to avoid duplicating.
        return
      case 'user_message':
        out.write(`[user] ${event.text}\n`)
        return
      case 'phone_action': {
        const p = event.payload
        out.write(`📷 phone_action: ${p.command}  (exit ${p.exitCode})\n`)
        if (p.screenshots.before) out.write(`   before:    ${p.screenshots.before}\n`)
        if (p.screenshots.annotated) out.write(`   annotated: ${p.screenshots.annotated}\n`)
        if (p.screenshots.after) out.write(`   after:     ${p.screenshots.after}\n`)
        if (open && p.screenshots.annotated) {
          spawn('open', [p.screenshots.annotated], { stdio: 'ignore', detached: true }).unref()
        }
        return
      }
      case 'escalation_requested':
        out.write(`⚠ escalation: ${event.payload.prompt}\n`)
        out.write(`   token: ${event.token}\n`)
        return
      case 'escalation_resolved':
        out.write(`✓ escalation ${event.token} → ${event.decision}${event.message ? `: ${event.message}` : ''}\n`)
        return
      case 'pi':
        return handlePiEvent(event.event, { out, err, turnCount: () => turnCount, bumpTurn: () => turnCount++, runStartTs: () => runStartTs, setRunStart: t => { runStartTs = t } })
    }
  }
}

interface PiCtx {
  out: NodeJS.WritableStream
  err: NodeJS.WritableStream
  turnCount: () => number
  bumpTurn: () => void
  runStartTs: () => number | null
  setRunStart: (t: number) => void
}

function handlePiEvent(piEvent: import('@mariozechner/pi-agent-core').AgentEvent, ctx: PiCtx) {
  switch (piEvent.type) {
    case 'agent_start':
      ctx.setRunStart(Date.now())
      return
    case 'agent_end': {
      const start = ctx.runStartTs()
      const elapsedMs = start ? Date.now() - start : 0
      ctx.out.write(`■ done in ${(elapsedMs / 1000).toFixed(1)}s, ${ctx.turnCount()} turns\n`)
      return
    }
    case 'turn_start':
      ctx.bumpTurn()
      return
    case 'message_end':
      printAssistantMessage(piEvent.message, ctx.out)
      return
    case 'tool_execution_start':
      ctx.out.write(`┌ ${piEvent.toolName}$ ${formatArgsOneLine(piEvent.args)}\n`)
      return
    case 'tool_execution_end': {
      const ok = !piEvent.isError
      const r = piEvent.result as { content?: Array<{ text?: string }> } | undefined
      const text = r?.content?.find(c => typeof c.text === 'string')?.text
      const tail = text ? text.split('\n').slice(0, 3).join('\n') : '(no output)'
      ctx.out.write(`└ ${ok ? 'ok' : 'error'}\n`)
      if (tail.length > 0) {
        for (const line of tail.split('\n')) ctx.out.write(`  ${line}\n`)
      }
      return
    }
    default:
      return
  }
}

function printAssistantMessage(msg: AgentMessage, out: NodeJS.WritableStream) {
  if (!msg || typeof msg !== 'object' || !('role' in msg)) return
  if (msg.role !== 'assistant') return
  const content = (msg as { content?: unknown }).content
  if (!Array.isArray(content)) return
  const texts = content
    .filter((c: unknown): c is { type: string; text: string } =>
      typeof c === 'object' && c !== null && (c as { type?: string }).type === 'text'
        && typeof (c as { text?: unknown }).text === 'string',
    )
    .map(c => c.text)
  for (const t of texts) {
    out.write(`[assistant] ${t}\n`)
  }
}

function formatArgsOneLine(args: unknown): string {
  if (!args) return ''
  if (typeof args === 'string') return args
  if (typeof args === 'object' && args !== null) {
    const obj = args as Record<string, unknown>
    if (typeof obj.command === 'string') return obj.command
    return JSON.stringify(obj)
  }
  return String(args)
}
