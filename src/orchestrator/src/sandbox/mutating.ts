/**
 * `isMutating(command)` — does a bash command issued by the agent
 * require human approval before running?
 *
 * Mutating commands are otacon verbs that change phone state (tap,
 * swipe, type, key, app launch/stop, etc.). Read-only verbs (info,
 * snapshot, screenshot, list*) bypass the approval gate. Anything that
 * isn't `otacon ...` returns false (the agent can run shell utilities
 * like cat/echo/ls without approval).
 *
 * Lives in its own module so both `build-fs.ts` and the workflow body's
 * `isMutatingStep` can import it without dragging in the sandbox
 * builder.
 */
import { otaconRegistry } from 'otacon-cli/commands/otacon'

const MUTATING_VERBS = new Set(
  Object.entries(otaconRegistry).filter(([, spec]) => spec.isMutating).map(([k]) => k),
)

export function isMutating(command: string): boolean {
  const trimmed = command.trim()
  const match = trimmed.match(/^otacon\s+(\S+)/)
  if (!match) return false
  return MUTATING_VERBS.has(match[1])
}
