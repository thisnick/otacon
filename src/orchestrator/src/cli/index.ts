/**
 * `orchestrator` CLI entry point.
 *
 * Subcommands:
 *   - run       — run an agent session against a workspace.
 *   - sessions  — list/inspect sessions.
 *   - serve     — run the HTTP API server.
 *   - ui        — open the bundled web UI in a browser.
 */
import { Command } from 'commander'
import { registerRun } from './run.js'
import { registerSessionsList } from './sessions-list.js'
import { registerServe } from './serve.js'
import { registerUi } from './ui.js'

const program = new Command()
program
  .name('orchestrator')
  .description('Otacon orchestrator — Pi-based agent runner.')
  .version('0.1.0')

registerRun(program)
registerSessionsList(program)
registerServe(program)
registerUi(program)

program.parseAsync(process.argv).catch(err => {
  console.error(err)
  process.exit(1)
})
