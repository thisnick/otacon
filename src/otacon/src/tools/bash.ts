/**
 * `bash` Pi tool — runs a command line through the closure-bound `Bash`
 * sandbox. Sets `OTACON_TOOL_CALL_ID` + `OTACON_RATIONALE` env so the
 * `otacon` custom command can persist traces under the right tcid.
 */
import { Type } from 'typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { Bash } from 'just-bash'

export interface BashToolOpts {
  bash: Bash
}

const BashSchema = Type.Object({
  command: Type.String({ description: 'The bash command to run.' }),
  rationale: Type.String({ description: 'Why you are running this command.' }),
})

export interface BashToolDetails {
  command: string
  stdout: string
  stderr: string
  exitCode: number
}

export function makeBashTool(opts: BashToolOpts): AgentTool<typeof BashSchema, BashToolDetails> {
  return {
    name: 'bash',
    label: 'Bash',
    description:
      'Run a bash command in the workspace sandbox. Available commands: `otacon` (phone control), `otacon-alloc` (phone lease — provision auto-runs), and standard utilities (cat, echo, ls, grep). Use `rationale` to explain intent.',
    parameters: BashSchema,
    async execute(toolCallId, params): Promise<AgentToolResult<BashToolDetails>> {
      const result = await opts.bash.exec(params.command, {
        env: {
          OTACON_TOOL_CALL_ID: toolCallId,
          OTACON_RATIONALE: params.rationale,
        },
      })
      let text = ''
      if (result.stdout) text += result.stdout
      if (result.stderr) text += (text ? '\n' : '') + `[stderr] ${result.stderr}`
      if (result.exitCode !== 0) text += (text ? '\n' : '') + `[exit code: ${result.exitCode}]`
      const final = text || '(no output)'
      return {
        content: [{ type: 'text', text: final }],
        details: {
          command: params.command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
      }
    },
  }
}
