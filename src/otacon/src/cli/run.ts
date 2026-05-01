/**
 * `otacon run` subcommand. Resolves workspace + team, optionally resume
 * mode, then calls runSession.
 */
import type { Command } from 'commander'
import { runSession } from '../runtime/run.js'
import { dataRoot } from '../storage/paths.js'

export interface RunCommandOpts {
  workspace: string
  team: string
  new?: boolean
  session?: string
  autoApprove?: boolean
  autoReject?: boolean
  openScreenshots?: boolean
  modelProvider?: string
  phoneClientBaseUrl?: string
}

export function registerRun(program: Command): void {
  program
    .command('run')
    .description('Run an agent session against a workspace.')
    .requiredOption('-w, --workspace <id>', 'Workspace id (e.g. xhs:test).')
    .requiredOption('-t, --team <name>', 'Team name (e.g. social-media-engagement).')
    .option('--new', 'Force a new session (ignore last-session.txt).')
    .option('-s, --session <id>', 'Resume the specific historical session id.')
    .option('--auto-approve', 'Auto-approve every mutating bash call (no TTY prompt).')
    .option('--auto-reject', 'Auto-reject every mutating bash call (for testing).')
    .option('--open-screenshots', 'Open annotated.png in macOS Preview after each phone action.')
    .option('--model-provider <id>', 'Model provider id (default: anthropic).')
    .option('--phone <url>', 'OtaconClient base URL for the phone (e.g. https://otacon-pi.tail0437b8.ts.net/phones/phone-r5ct60sd).')
    .argument('<message...>', 'User message (text). Joined with spaces.')
    .action(async (messageWords: string[], optsRaw: RunCommandOpts) => {
      const root = dataRoot()
      const message = messageWords.join(' ')
      const resume: 'last' | 'new' | string =
        optsRaw.new === true ? 'new' :
        typeof optsRaw.session === 'string' ? optsRaw.session :
        'last'

      const result = await runSession({
        dataRoot: root,
        workspaceId: optsRaw.workspace,
        teamName: optsRaw.team,
        resume,
        userMessage: message,
        modelProvider: optsRaw.modelProvider,
        phoneClientBaseUrl: optsRaw.phoneClientBaseUrl,
        openScreenshots: optsRaw.openScreenshots,
        autoApprove: optsRaw.autoApprove,
        autoReject: optsRaw.autoReject,
      })

      if (result.status === 'completed') {
        process.exit(0)
      } else {
        process.exit(1)
      }
    })
}
