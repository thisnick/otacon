/**
 * `isMutating(command)` + `isMutatingOtacon(verb, args)` — does an otacon
 * invocation actually change device state?
 *
 * The CLI's `CommandSpec.isMutating` flag is a conservative top-level gate:
 * `apps`, `clipboard`, `sms`, `notifications`, `record`, `call` are all
 * marked mutating because *some* of their subcommands mutate, but the
 * common read-only subs (`apps list`, `clipboard get`, `sms list`,
 * `record status`, etc.) don't. The CLI itself uses an inner
 * `isMutatingSub` check before drawing trace overlays.
 *
 * The orchestrator's auto-screenshot wrapper and the workflow's approval
 * gate reuse this module:
 *   - `isMutating(command)` — used by `lead-agent.ts/isMutatingStep` to
 *     decide whether the bash tool needs human approval before running.
 *   - `isMutatingOtacon(verb, args)` — used by `build-fs.ts` to decide
 *     whether to capture before/annotated/after screenshots and emit a
 *     `data-phone-action` chunk.
 *
 * Both predicates honor the per-verb subcommand-aware allowlist below.
 * Anything that isn't `otacon ...` returns false — shell utilities like
 * cat/echo/ls bypass approval entirely.
 */
import { otaconRegistry } from 'otacon-cli/commands/otacon'

/** Verbs whose first arg decides whether this invocation mutates. */
const SUBCOMMAND_MATRIX: Record<string, { mutating: ReadonlySet<string>; defaultSub?: string }> = {
  apps: { mutating: new Set(['launch', 'stop', 'install']), defaultSub: 'list' },
  call: { mutating: new Set(['dial', 'answer', 'hangup']), defaultSub: 'status' },
  clipboard: { mutating: new Set(['set']), defaultSub: 'get' },
  notifications: { mutating: new Set(['dismiss', 'action']), defaultSub: 'list' },
  record: { mutating: new Set(['start', 'stop']), defaultSub: 'status' },
  sms: { mutating: new Set(['send']), defaultSub: 'list' },
}
const SUBCOMMAND_VERBS = new Set(Object.keys(SUBCOMMAND_MATRIX))

/**
 * Verbs that mutate regardless of their args (tap, swipe, scroll, …).
 * Sourced from `otaconRegistry`'s `isMutating: true` set, then narrowed
 * by removing the subcommand-aware verbs above.
 */
const ALWAYS_MUTATING = new Set(
  Object.entries(otaconRegistry)
    .filter(([k, spec]) => spec.isMutating && !SUBCOMMAND_VERBS.has(k))
    .map(([k]) => k),
)

/**
 * Does an `otacon <verb> [args...]` invocation mutate device state?
 *
 * Returns `false` for non-otacon commands (shell utilities), unknown
 * verbs, and otacon read-only verbs / subs.
 */
export function isMutatingOtacon(verb: string, args: string[]): boolean {
  if (!otaconRegistry[verb]) return false
  if (ALWAYS_MUTATING.has(verb)) return true
  const matrix = SUBCOMMAND_MATRIX[verb]
  if (matrix) {
    const sub = args[0] ?? matrix.defaultSub ?? ''
    return matrix.mutating.has(sub)
  }
  return false
}

/**
 * Bash-string wrapper around `isMutatingOtacon`. Handles the common
 * `otacon ...` prefix; anything else returns false.
 */
export function isMutating(command: string): boolean {
  const trimmed = command.trim()
  const match = trimmed.match(/^otacon\s+(\S+)(?:\s+(.*))?$/)
  if (!match) return false
  const verb = match[1]
  const rest = match[2] ?? ''
  // Crude tokenization is fine here — the predicate only inspects the
  // first token (the subcommand). Quoted args don't change that.
  const args = rest.split(/\s+/).filter(Boolean)
  return isMutatingOtacon(verb, args)
}
