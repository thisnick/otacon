/**
 * `orchestrator serve` subcommand. Boots the HTTP API server.
 *
 * Defaults: port 9090, host 0.0.0.0, data root from
 * `ORCHESTRATOR_DATA_DIR`. Env `PORT` overrides `--port` so the server
 * fits the platform conventions when deployed.
 */
import type { Command } from 'commander'
import { startServer } from '../server/index.js'

export interface ServeCommandOpts {
  port?: string
  host?: string
}

export function registerServe(program: Command): void {
  program
    .command('serve')
    .description('Run the orchestrator HTTP API server.')
    .option('-p, --port <number>', 'Port to listen on (default 9090; PORT env overrides flag).')
    .option('-H, --host <addr>', 'Hostname/IP to bind (default 0.0.0.0).')
    .action(async (optsRaw: ServeCommandOpts) => {
      const port = optsRaw.port !== undefined ? Number(optsRaw.port) : undefined
      const host = optsRaw.host
      const server = await startServer({ port, host })
      const shutdown = async () => {
        process.stderr.write(`\n[orchestrator-server] shutting down\n`)
        try { await server.close() } catch {}
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      // Keep the event loop alive — `serve()` already does, but be explicit.
      await new Promise<void>(() => {})
    })
}
