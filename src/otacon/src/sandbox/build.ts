/**
 * Build a `just-bash` instance rooted at the workspace dir, with custom
 * `otacon` + `otacon-alloc` commands. Spike-shaped: the auto-screenshot
 * wrapper runs around `otacon` mutating subcommands and emits
 * `phone_action` events to the SessionBus.
 *
 * Filesystem ACL note (spike): Bash's `ReadWriteFs` root is the workspace
 * dir, with cwd at `sessions/<id>/sandbox/`. The agent CAN escape via
 * `cat ../../credentials.json` — strict ACL is a P2 task. Spike accepts
 * this risk because credentials are non-sensitive in the test harness.
 */
import * as path from 'node:path'
import { Bash, defineCommand, ReadWriteFs } from 'just-bash'
import { OtaconClient } from 'otacon-cli/client'
import { otaconRegistry } from 'otacon-cli/commands/otacon'
import { ulid } from 'ulid'
import type { SessionBus } from '../runtime/session-bus.js'
import type { OtaconEvent, PhoneActionPayload } from '../types.js'
import { isMutatingOtacon } from './mutating.js'
import { redactPhoneIdentifiers } from './redact.js'
import { annotateScreenshot, inferAnnotation } from './annotate.js'
import { writeScreenshot, writeToolResult } from '../storage/session.js'

export interface BuildBashOpts {
  /** `.otacon-data` root dir. */
  dataRoot: string
  workspaceId: string
  teamName: string
  sessionId: string
  /** Workspace root dir used as the bash FS root (allows reach to env/memory). */
  workspaceRoot: string
  /** Sandbox subdir set as the bash cwd (`sessions/<id>/sandbox/`). */
  sandboxDir: string
  /** Workspace's external client base URL (e.g. host's /phones/<id>) — null until alloc is set. */
  getClientBaseUrl: () => string | null
  /** Bus for emitting `phone_action` events. */
  bus: SessionBus
}

export function buildBash(opts: BuildBashOpts): Bash {
  const otaconCmd = defineCommand('otacon', async (args, ctx) => {
    const [verb, ...rest] = args
    if (!verb) {
      return {
        stdout: '',
        stderr: 'Usage: otacon <command> [args...]\n',
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
    const baseUrl = opts.getClientBaseUrl()
    if (!baseUrl) {
      return {
        stdout: '',
        stderr: 'NO_PHONE: no phone client configured for this session.\n',
        exitCode: 1,
      }
    }
    const client = new OtaconClient(baseUrl)
    const isMutating = isMutatingOtacon(verb, rest)
    // Tool call ID: prefer one from the env (set by Pi tool execute), else
    // synth one. Allows the screenshot wrapper to land artifacts in a
    // predictable per-call dir even if Pi doesn't propagate the id.
    const toolCallId = ctx.env.get('OTACON_TOOL_CALL_ID') ?? ulid()
    const rationale = ctx.env.get('OTACON_RATIONALE') ?? ''

    const startedAt = Date.now()
    const screenshots: PhoneActionPayload['screenshots'] = {
      before: null,
      annotated: null,
      after: null,
    }

    if (isMutating) {
      try {
        let snapshot: unknown = null
        try {
          snapshot = await client.snapshot('json')
        } catch (e) {
          console.error(`[bash] snapshot failed for ${verb}:`, (e as Error).message)
        }
        const beforeBytes = await client.screenshot()
        screenshots.before = await writeScreenshot(
          opts.dataRoot, opts.workspaceId, opts.teamName, opts.sessionId,
          toolCallId, 'before', beforeBytes,
        )

        const annotation = await inferAnnotation({
          verb, args: rest, client,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          snapshot: snapshot as any,
        })
        if (annotation) {
          const annotatedBytes = await annotateScreenshot(beforeBytes, annotation)
          screenshots.annotated = await writeScreenshot(
            opts.dataRoot, opts.workspaceId, opts.teamName, opts.sessionId,
            toolCallId, 'annotated', annotatedBytes,
          )
        }
      } catch (e) {
        console.error(`[bash] before/annotated capture failed for ${verb}:`, e)
      }
    }

    let stdout = ''
    let stderr = ''
    let exitCode = 0
    try {
      let out = await spec.run(rest, client, {})
      out = redactPhoneIdentifiers(out)
      stdout = out + (out.endsWith('\n') ? '' : '\n')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      stderr = `otacon ${verb}: ${msg}\n`
      exitCode = 1
    }

    if (isMutating) {
      try {
        const afterBytes = await client.screenshot()
        screenshots.after = await writeScreenshot(
          opts.dataRoot, opts.workspaceId, opts.teamName, opts.sessionId,
          toolCallId, 'after', afterBytes,
        )
      } catch (e) {
        console.error(`[bash] after capture failed for ${verb}:`, e)
      }
    }

    // Persist tool result + emit phone_action event for mutating verbs.
    try {
      await writeToolResult(
        opts.dataRoot, opts.workspaceId, opts.teamName, opts.sessionId,
        toolCallId,
        { command: ['otacon', verb, ...rest].join(' '), rationale, stdout, stderr, exitCode },
      )
    } catch (e) {
      console.error(`[bash] writeToolResult failed:`, e)
    }

    if (isMutating) {
      const payload: PhoneActionPayload = {
        toolCallId,
        command: ['otacon', verb, ...rest].join(' '),
        subcommand: verb,
        target: rest.join(' '),
        rationale,
        startedAt,
        completedAt: Date.now(),
        exitCode,
        stdout,
        stderr,
        screenshots,
      }
      const event: OtaconEvent = { kind: 'phone_action', payload, ts: Date.now() }
      opts.bus.emit(event)
    }

    return { stdout, stderr, exitCode }
  })

  // Spike: no allocation system. The phone is bound at session start via
  // getClientBaseUrl() — the `provision` flow will be added when the
  // multi-phone story matters. `provision` reports the actual binding
  // state so the agent isn't misled when no phone is wired.
  const otaconAllocCmd = defineCommand('otacon-alloc', async (args) => {
    const [verb] = args
    if (verb === 'provision') {
      const baseUrl = opts.getClientBaseUrl()
      if (!baseUrl) {
        return {
          stdout: '',
          stderr: 'NO_PHONE: no phone bound to this session. Re-run with --phone <url>.\n',
          exitCode: 1,
        }
      }
      return { stdout: `phone bound at session start (spike — no real allocation): ${baseUrl}\n`, stderr: '', exitCode: 0 }
    }
    return {
      stdout: '',
      stderr: `otacon-alloc ${verb ?? '?'}: not implemented in spike — phone is bound at session start.\n`,
      exitCode: 1,
    }
  })

  // Bash root = workspaceRoot so the agent can reach env/memory siblings.
  // Strict ACL is a P2 task (would need a path-rewriting MountableFs).
  const fs = new ReadWriteFs({ root: path.resolve(opts.workspaceRoot), allowSymlinks: true })

  // cwd is sandboxDir RELATIVE TO workspaceRoot. Bash treats `cwd` as a
  // path inside the configured `fs`, not an OS path.
  const relCwd = '/' + path.relative(opts.workspaceRoot, opts.sandboxDir)

  return new Bash({
    customCommands: [otaconCmd, otaconAllocCmd],
    fs,
    cwd: relCwd,
  })
}
