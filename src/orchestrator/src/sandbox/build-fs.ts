/**
 * `buildSandboxFs` — orchestrator-v2 sandbox builder.
 *
 * Wraps `defineCommand('otacon', ...)` so every mutating subcommand produces
 * a `before/annotated/after` screenshot triplet (persisted via `BlobStore`)
 * plus a `data-phone-action` posterity event on the workflow's writable
 * stream. Read-only verbs (info, snapshot, screenshot, …) bypass the wrapper
 * — no extra screenshots, no posterity event.
 */
import { Bash, defineCommand, MountableFs, InMemoryFs } from 'just-bash'
import { BlobBackedFs } from '../storage/blob-fs.js'
import type { BlobStore } from '../storage/blob-store.js'
import type { AllocationStore } from '../storage/allocation-store.js'
import type { AllocationContext } from './allocation-context.js'
import { OtaconClient } from 'otacon-cli/client'
import { otaconRegistry } from 'otacon-cli/commands/otacon'
import { buildAllocRegistryFs } from './alloc-commands-fs.js'
import { redactPhoneIdentifiers } from './redact.js'
import { annotateScreenshot, inferAnnotation } from './annotate.js'
import { isMutatingOtacon } from './mutating.js'
import {
  buildScreenshotUrls,
  emitPhoneAction,
  type PhoneActionPayload,
} from '../run-executor/posterity-events.js'

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
    const subprocessEnv: Record<string, string | undefined> = {}
    const traceDir = ctx.env.get('OTACON_TRACE_DIR')
    if (traceDir) subprocessEnv.OTACON_TRACE_DIR = traceDir

    const toolCallId = ctx.env.get('OTACON_TOOL_CALL_ID')
    const rationale = ctx.env.get('OTACON_RATIONALE') ?? ''
    // Subcommand-aware: `apps list`, `sms list`, `clipboard get` etc. are
    // read-only despite their top-level CommandSpec.isMutating=true. See
    // SUBCOMMAND_MATRIX in mutating.ts.
    const isMutating = isMutatingOtacon(verb, rest)
    const client = new OtaconClient(active.clientBaseUrl)

    // Capture before-screenshot + annotated overlay for mutating verbs.
    // Best-effort: capture failures don't block the command itself —
    // the agent's task is to control the phone, not produce telemetry.
    const startedAt = Date.now()
    let beforeOk = false
    let annotatedOk = false
    let afterOk = false
    if (isMutating && toolCallId) {
      try {
        // Snapshot first so refs (e5, etc.) resolve while bounds are
        // still fresh — the action is about to mutate the screen.
        let snapshot: unknown = null
        try {
          snapshot = await client.snapshot('json')
        } catch {
          /* swallow — annotation infer will fall back to text labels */
        }

        const beforeBytes = await client.screenshot()
        await blobStore.putScreenshot(runId, toolCallId, 'before', beforeBytes)
        beforeOk = true

        const annotation = await inferAnnotation({
          verb,
          args: rest,
          client,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          snapshot: snapshot as any,
        })
        if (annotation) {
          const annotatedBytes = await annotateScreenshot(beforeBytes, annotation)
          await blobStore.putScreenshot(runId, toolCallId, 'annotated', annotatedBytes)
          annotatedOk = true
        }
      } catch (e) {
        console.error(`[sandbox] before/annotated capture failed for ${verb} ${toolCallId}:`, e)
      }
    }

    // Run the actual otacon subcommand.
    let stdout = ''
    let stderr = ''
    let exitCode = 0
    try {
      let out = await spec.run(rest, client, subprocessEnv)
      out = redactPhoneIdentifiers(out)
      stdout = out + (out.endsWith('\n') ? '' : '\n')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      stderr = `otacon ${verb}: ${msg}\n`
      exitCode = 1
    }

    // After-screenshot for mutating verbs (regardless of exit code — the
    // user wants to see the resulting state even on failures).
    if (isMutating && toolCallId) {
      try {
        const afterBytes = await client.screenshot()
        await blobStore.putScreenshot(runId, toolCallId, 'after', afterBytes)
        afterOk = true
      } catch (e) {
        console.error(`[sandbox] after capture failed for ${verb} ${toolCallId}:`, e)
      }
    }

    // Emit data-phone-action posterity chunk for mutating verbs. Best-
    // effort: a chunk-emit failure shouldn't surface as a tool error.
    if (isMutating && toolCallId) {
      try {
        const payload: PhoneActionPayload = {
          tool_call_id: toolCallId,
          command: ['otacon', verb, ...rest].join(' '),
          subcommand: verb,
          target: rest.join(' '),
          rationale,
          started_at: startedAt,
          completed_at: Date.now(),
          exit_code: exitCode,
          stdout,
          stderr,
          screenshots: buildScreenshotUrls(runId, toolCallId, {
            before: beforeOk,
            annotated: annotatedOk,
            after: afterOk,
          }),
        }
        await emitPhoneAction(payload)
      } catch (e) {
        console.error(`[sandbox] emit data-phone-action failed for ${verb} ${toolCallId}:`, e)
      }
    }

    return { stdout, stderr, exitCode }
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
