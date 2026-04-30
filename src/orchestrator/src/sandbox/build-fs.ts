/**
 * `buildSandboxFs` — orchestrator-v2 sandbox builder.
 *
 * Same shape as `buildSandbox` (in `build.ts`) but operates against
 * `AllocationStore` (FS-backed) instead of the Drizzle service. The
 * legacy `buildSandbox` stays in place for the `agent run` (legacy
 * Drizzle path) until commit 10 deletes it.
 *
 * The two builders share `redactPhoneIdentifiers` + `isMutating` from
 * `build.ts` to avoid duplication.
 */
import { Bash, defineCommand, MountableFs, InMemoryFs } from 'just-bash'
import { BlobBackedFs } from '../storage/blob-fs.js'
import type { BlobStore } from '../storage/blob.js'
import type { AllocationStore } from '../storage/allocation-store.js'
import type { AllocationContext } from './allocation-context.js'
import { OtaconClient } from 'otacon-cli/client'
import { otaconRegistry } from 'otacon-cli/commands/otacon'
import { buildAllocRegistryFs } from './alloc-commands-fs.js'
import { redactPhoneIdentifiers } from './redact.js'

interface SandboxFsOptions {
  blobStore: BlobStore
  accountId: string
  runId: string
  allocationStore: AllocationStore
  allocCtx: AllocationContext
}

export async function buildSandboxFs(opts: SandboxFsOptions): Promise<Bash> {
  const { blobStore, accountId, runId, allocationStore, allocCtx } = opts

  // Cold-start: rebuild allocCtx from the AllocationStore if a row
  // already exists for this runId.
  if (!allocCtx.peek()) {
    try {
      const fromFile = await allocationStore.getActive(runId)
      if (fromFile) {
        const resolved = await allocationStore.resolvePhoneForAccount(accountId)
        allocCtx.set({
          allocationId: fromFile.allocationId,
          phoneId: fromFile.phoneId,
          localPhoneId: resolved.localPhoneId,
          hostUrl: resolved.hostUrl,
          clientBaseUrl: resolved.clientBaseUrl,
          expiresAt: fromFile.expiresAt,
        })
      }
    } catch {
      // Registry unreachable — leave allocCtx empty; agent will see
      // "no phone" and call provision.
    }
  }

  const otaconCmd = defineCommand('otacon', async (args, ctx) => {
    const [verb, ...rest] = args
    if (!verb) {
      return {
        stdout: '',
        stderr: 'Usage: otacon <command> [args...]\n\nRun `otacon-alloc provision` first to acquire a phone.\n',
        exitCode: 1,
      }
    }
    const spec = otaconRegistry[verb]
    if (!spec) {
      return {
        stdout: '',
        stderr: `unknown otacon verb: ${verb}. Available: ${Object.keys(otaconRegistry).sort().join(', ')}\n`,
        exitCode: 1,
      }
    }
    const peek = allocCtx.peek()
    const active = allocCtx.get()
    if (!active) {
      const expired = peek && !active
      return {
        stdout: '',
        stderr: expired
          ? 'ALLOCATION_EXPIRED: lease has expired. Run `otacon-alloc provision` to renew.\n'
          : 'NO_ALLOCATION: no phone allocated. Run `otacon-alloc provision` first.\n',
        exitCode: 1,
      }
    }
    const env: Record<string, string | undefined> = {}
    const traceDir = ctx.env.get('OTACON_TRACE_DIR')
    if (traceDir) env.OTACON_TRACE_DIR = traceDir

    const client = new OtaconClient(active.clientBaseUrl)
    try {
      let out = await spec.run(rest, client, env)
      out = redactPhoneIdentifiers(out)
      return { stdout: out + (out.endsWith('\n') ? '' : '\n'), stderr: '', exitCode: 0 }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { stdout: '', stderr: `otacon ${verb}: ${msg}\n`, exitCode: 1 }
    }
  })

  const allocRegistry = buildAllocRegistryFs({ allocationStore, accountId, runId, allocCtx })
  const otaconAllocCmd = defineCommand('otacon-alloc', async (args) => {
    const [verb, ...rest] = args
    if (!verb) {
      return {
        stdout: '',
        stderr: `Usage: otacon-alloc <command> [args...]\n\nCommands: ${Object.keys(allocRegistry).join(', ')}\n`,
        exitCode: 1,
      }
    }
    const spec = allocRegistry[verb]
    if (!spec) {
      return {
        stdout: '',
        stderr: `unknown otacon-alloc verb: ${verb}. Available: ${Object.keys(allocRegistry).join(', ')}\n`,
        exitCode: 1,
      }
    }
    try {
      const out = await spec.run(rest)
      return { stdout: out + (out.endsWith('\n') ? '' : '\n'), stderr: '', exitCode: 0 }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { stdout: '', stderr: `otacon-alloc ${verb}: ${msg}\n`, exitCode: 1 }
    }
  })

  const workspaceFs = new BlobBackedFs(blobStore, `accounts/${accountId}/workspace`)
  const configFs = new BlobBackedFs(blobStore, `accounts/${accountId}/config`)

  const fs = new MountableFs({
    base: new InMemoryFs(),
    mounts: [
      { mountPoint: '/workspace', filesystem: workspaceFs },
      { mountPoint: '/config', filesystem: configFs },
    ],
  })

  return new Bash({
    customCommands: [otaconCmd, otaconAllocCmd],
    fs,
    cwd: '/workspace',
  })
}
