/**
 * Builds a just-bash sandbox with two custom commands:
 *   - `otacon`         dispatches through the shared CLI command registry
 *                      (src/cli/src/commands/otacon/index.ts) so the agent
 *                      and the human CLI execute the same code.
 *   - `otacon-alloc`   provision/release/status against the AllocationContext
 *                      + DB. The phone identity never leaks to the agent.
 *
 * The orchestrator owns the AllocationContext (in-memory, hidden from bash).
 * The `otacon` command consults it to construct an OtaconClient — if no
 * active allocation, it returns an error.
 */
import { Bash, defineCommand, MountableFs, InMemoryFs } from 'just-bash'
import { BlobBackedFs } from '../storage/blob-fs.js'
import type { BlobStore } from '../storage/blob.js'
import type { Db } from '../db/client.js'
import { OtaconClient } from 'otacon-cli/client'
import { otaconRegistry } from 'otacon-cli/commands/otacon'
import type { AllocationContext } from './allocation-context.js'
import { buildAllocRegistry } from './alloc-commands.js'
import * as allocSvc from '../services/allocations.js'

/** Verbs in the otacon registry that mutate phone state (need approval). */
const MUTATING_VERBS = new Set(
  Object.entries(otaconRegistry).filter(([, spec]) => spec.isMutating).map(([k]) => k),
)

export function isMutating(command: string): boolean {
  const trimmed = command.trim()
  // Match "otacon <verb>" — only otacon commands gate on approval
  const match = trimmed.match(/^otacon\s+(\S+)/)
  if (!match) return false
  return MUTATING_VERBS.has(match[1])
}

interface SandboxOptions {
  blobStore: BlobStore
  accountId: string
  conversationId: string
  db: Db
  allocCtx: AllocationContext
}

export async function buildSandbox(opts: SandboxOptions): Promise<Bash> {
  const { blobStore, accountId, conversationId, db, allocCtx } = opts

  // 1. Rebuild allocCtx from DB on cold start.
  // (e.g., the orchestrator restarted mid-session and the conversation
  //  already has an active row.)
  if (!allocCtx.peek()) {
    try {
      const fromDb = await allocSvc.getActive(db, conversationId)
      if (fromDb) {
        const resolved = await allocSvc.resolvePhoneForAccount(db, accountId)
        allocCtx.set({
          allocationId: fromDb.allocationId,
          phoneId: fromDb.phoneId,
          localPhoneId: resolved.localPhoneId,
          hostUrl: resolved.hostUrl,
          clientBaseUrl: resolved.clientBaseUrl,
          expiresAt: fromDb.expiresAt,
        })
      }
    } catch {
      // If we can't rebuild (e.g., registry unreachable), continue —
      // agent will see "no phone" and call provision.
    }
  }

  // 2. otacon defineCommand: dispatch through the shared registry, but
  //    consult AllocationContext for the phone identity. Never expose
  //    the phone ID through env vars.
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

    // Allocation gate
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

    // Build env for the registry: pass through OTACON_TRACE_DIR (if the
    // bash invocation set it). Never include the phone ID.
    const env: Record<string, string | undefined> = {}
    const traceDir = ctx.env.get('OTACON_TRACE_DIR')
    if (traceDir) env.OTACON_TRACE_DIR = traceDir

    // Use the pre-built clientBaseUrl which embeds the host-LOCAL phone ID.
    // NEVER use `${hostUrl}/phones/${phoneId}` — phoneId is the registry ID,
    // which is NOT what the host serves. (See feedback_dual_id_system.md.)
    const client = new OtaconClient(active.clientBaseUrl)

    try {
      let out = await spec.run(rest, client, env)
      // Redact phone-identifying fields before returning to the agent.
      // The CLI binary still shows full info to humans — this is the
      // orchestrator-side privacy boundary.
      out = redactPhoneIdentifiers(out)
      return { stdout: out + (out.endsWith('\n') ? '' : '\n'), stderr: '', exitCode: 0 }
    } catch (e: any) {
      return { stdout: '', stderr: `otacon ${verb}: ${e.message ?? String(e)}\n`, exitCode: 1 }
    }
  })

  // 3. otacon-alloc defineCommand
  const allocRegistry = buildAllocRegistry({ db, accountId, conversationId, allocCtx })
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
    } catch (e: any) {
      return { stdout: '', stderr: `otacon-alloc ${verb}: ${e.message ?? String(e)}\n`, exitCode: 1 }
    }
  })

  // Set up blob-backed FS for workspace and config
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

/** Re-export for the orchestrator's tool reference + alloc registry tooling. */
export { otaconRegistry }
export { buildAllocRegistry }

/**
 * Phone-identifying fields that must NEVER appear in agent-visible output.
 *
 * These are identifiers (adb_serial, IMEI, eSIM EID, BT MACs) that would
 * give the agent a way to learn the phone's identity even though the
 * orchestrator hides phone IDs in env vars and tool descriptions. Stripped
 * from the `info` and `snapshot` payloads on the orchestrator side so the
 * CLI binary (used by humans) still gets the full data.
 */
const REDACTED_FIELDS = [
  'adb_serial',
  'phone_bt_mac',
  'adapter_mac',
  'imei',
  'imei2',
  'eid',
  'vnc_port',
] as const

/**
 * Strip phone-identifying values from agent-visible command output. Handles
 * both JSON (parsed and re-serialized) and the line-aligned `key  value`
 * text format used by `otacon info`.
 */
export function redactPhoneIdentifiers(out: string): string {
  if (!out) return out
  const trimmed = out.trim()

  // JSON payload: parse, redact, re-serialize.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      const redacted = walkRedact(parsed)
      return JSON.stringify(redacted, null, 2)
    } catch {
      // fall through to regex-based redaction
    }
  }

  // Text payload (e.g. `otacon info` line-aligned output): match each line
  // beginning with a known field key and blank its value.
  let result = out
  for (const key of REDACTED_FIELDS) {
    const re = new RegExp(`^(${key}\\s+).+$`, 'gm')
    result = result.replace(re, '$1[redacted]')
  }
  return result
}

function walkRedact(node: any): any {
  if (Array.isArray(node)) return node.map(walkRedact)
  if (node && typeof node === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(node)) {
      if ((REDACTED_FIELDS as readonly string[]).includes(k)) {
        out[k] = '[redacted]'
      } else {
        out[k] = walkRedact(v)
      }
    }
    return out
  }
  return node
}
