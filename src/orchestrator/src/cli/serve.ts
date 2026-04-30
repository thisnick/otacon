/**
 * `serve` — boot the Nitro dev (or prod) server as a child process.
 *
 * Surface in the user-facing CLI: `pnpm orchestrator serve`. Spawns
 * `nitro dev` (or `node .output/server/index.mjs` with `--prod`),
 * pipes stdio, and forwards the exit code. Lets the e2e suite spawn
 * the orchestrator with a single command instead of `cd src/orchestrator
 * && pnpm dev`.
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface ServeOptions {
  prod?: boolean
}

export async function serveCommand(opts: ServeOptions = {}): Promise<void> {
  // Anchor cwd to the orchestrator package dir so relative paths in
  // nitro.config.ts (`serverDir: 'server'`, `scanDirs: ['workflows']`)
  // resolve correctly regardless of where the user invoked us from.
  const orchDir = path.resolve(__dirname, '..', '..')

  let bin: string
  let args: string[]
  if (opts.prod) {
    bin = 'node'
    args = [path.join(orchDir, '.output', 'server', 'index.mjs')]
  } else {
    bin = path.join(orchDir, 'node_modules', '.bin', 'nitro')
    args = ['dev']
  }

  const child = spawn(bin, args, {
    cwd: orchDir,
    stdio: 'inherit',
    env: process.env,
  })
  await new Promise<void>((resolve, reject) => {
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal)
        return
      }
      process.exitCode = code ?? 0
      resolve()
    })
    child.on('error', reject)
  })
}
