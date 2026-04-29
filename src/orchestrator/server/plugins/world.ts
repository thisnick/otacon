/**
 * Wire the workflow runtime to use `@workflow/world-local` rooted at
 * ${ORCHESTRATOR_DATA_DIR}/workflow/.
 *
 * Nitro plugins run once at server startup before any route handlers fire.
 * That's the right time to call `setWorld()` so subsequent `start()` /
 * `getRun()` / `resumeHook()` calls see our local world.
 *
 * Defaults:
 *   ORCHESTRATOR_DATA_DIR = .orchestrator-data (matches storage layer)
 *
 * The world's `start()` re-enqueues any active runs from a prior process —
 * survives crashes and dev-server reloads.
 */
import path from 'node:path'
import { setWorld } from '@workflow/core/runtime'
import { createLocalWorld } from '@workflow/world-local'

/**
 * Nitro plugin: runs once at server startup before any request handlers.
 *
 * Nitro 3.0.1-alpha.1 plugin signature is `(nitroApp) => void | Promise<void>`
 * — it does not auto-import `defineNitroPlugin`. We just default-export the
 * async function.
 *
 * `setWorld(createLocalWorld({...}))` makes `start()`, `getRun()`, and
 * `resumeHook()` from `workflow/api` use the local-FS world rooted at
 * `${ORCHESTRATOR_DATA_DIR}/workflow/`.
 */
export default async function () {
  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const workflowDir = path.resolve(dataDir, 'workflow')

  const world = createLocalWorld({ dataDir: workflowDir })
  setWorld(world)
  await world.start?.()

  console.log(`[orchestrator] world-local mounted at ${workflowDir}`)
}
