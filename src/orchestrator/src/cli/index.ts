/**
 * `orchestrator` CLI entry point.
 *
 * Subcommands:
 *   - run       — run an agent session against a workspace.
 *   - sessions  — list/inspect sessions.
 */
import { Command } from 'commander'
import { registerRun } from './run.js'
import { registerSessionsList } from './sessions-list.js'

const program = new Command()
program
  .name('orchestrator')
  .description('Otacon orchestrator — Pi-based agent runner.')
  .version('0.1.0')

registerRun(program)
registerSessionsList(program)

program.parseAsync(process.argv).catch(err => {
  console.error(err)
  process.exit(1)
})
