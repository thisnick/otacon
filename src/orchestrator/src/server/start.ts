/**
 * Orchestrator server entry point.
 *
 * Env-driven; no flags. Reads PORT, HOST, ORCHESTRATOR_DATA_DIR and
 * delegates to `startServer`. This is what `Dockerfile.orchestrator`'s
 * CMD invokes and what `pnpm dev` runs under tsx --watch.
 */
import { startServer } from './index.js'

const port = Number(process.env.PORT ?? 9090)
const host = process.env.HOST ?? '0.0.0.0'
const dataRootEnv = process.env.ORCHESTRATOR_DATA_DIR
const dataRoot = dataRootEnv && dataRootEnv.length > 0 ? dataRootEnv : undefined

const server = await startServer({ port, host, dataRoot })

const shutdown = async (signal: string) => {
  process.stderr.write(`\n[orchestrator-server] received ${signal}, shutting down\n`)
  try { await server.close() } catch {}
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
