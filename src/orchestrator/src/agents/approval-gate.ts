/**
 * `beforeToolCall` approval gate.
 *
 * Spike: TTY prompt for any `bash` invocation that mutates phone state
 * (per `isMutating(command)`). Read-only commands and non-bash tools
 * pass through.
 *
 * Returning `{block: true, reason}` short-circuits Pi's tool execution
 * and surfaces `reason` as a synthetic tool-result error to the model.
 */
import readline from 'node:readline'
import type { BeforeToolCallContext, BeforeToolCallResult } from '@mariozechner/pi-agent-core'
import { isMutating } from '../sandbox/mutating.js'

export type ApprovalDecision = 'approve' | 'reject' | 'skip'

export interface ApprovalGateOpts {
  /** When true, auto-approve everything (e.g. for non-interactive testing). */
  autoApprove?: boolean
  /** When true, auto-reject everything (good for verifying the rejection path). */
  autoReject?: boolean
}

export function makeApprovalGate(opts: ApprovalGateOpts = {}) {
  return async (ctx: BeforeToolCallContext, _signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> => {
    if (ctx.toolCall.name !== 'bash') return undefined
    const args = ctx.args as { command?: string; rationale?: string } | undefined
    const command = args?.command ?? ''
    if (!isMutating(command)) return undefined

    if (opts.autoApprove) return undefined
    if (opts.autoReject) return { block: true, reason: 'auto-reject mode' }

    const rationale = args?.rationale ?? '(no rationale)'
    const decision = await ttyPrompt(`\n⚠ approve mutating command?\n  $ ${command}\n  rationale: ${rationale}\n[y/n/s] `)
    if (decision === 'approve') return undefined
    if (decision === 'skip') return { block: true, reason: 'User skipped this tool call.' }
    return { block: true, reason: 'User rejected this tool call.' }
  }
}

async function ttyPrompt(prompt: string): Promise<ApprovalDecision> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    rl.question(prompt, ans => {
      rl.close()
      const a = ans.trim().toLowerCase()
      if (a === 'y' || a === 'yes' || a === 'approve') return resolve('approve')
      if (a === 's' || a === 'skip') return resolve('skip')
      return resolve('reject')
    })
  })
}
