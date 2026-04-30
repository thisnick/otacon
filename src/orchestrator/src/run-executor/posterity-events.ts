/**
 * Posterity event chunk builders + emitters.
 *
 * "Posterity" events are `data-*` UIMessageChunks that the orchestrator emits
 * into the workflow's writable stream alongside the AI SDK's model-level
 * `tool-call` / `tool-result` chunks. They are additive — the model-level
 * chunks are always forwarded as-is. Posterity events carry orchestrator-side
 * context: lifecycle markers (`data-run-started/completed/failed`), approval
 * signal status (`data-signal-created/resolved`), and Phase 2's headline
 * `data-phone-action`.
 *
 * The `data-phone-action` chunk packs the bash command, its exit/stdio, and
 * URLs to the `before/annotated/after` screenshots so a single event is
 * sufficient for the UI to render a phone-action card. Schema lives at
 * `docs/orchestrator-v2-plan.md` line 546.
 *
 * MUST be called from inside a `'use step'` function — `getWritable()` from
 * the workflow body throws ENOTSUP.
 */
import { ulid } from 'ulid'
import { getWritable } from 'workflow'
import type { UIMessageChunk } from 'ai'

export interface PhoneActionPayload {
  /** AI SDK tool-call id this action corresponds to (the `bash` invocation). */
  tool_call_id: string
  /** The full bash command string, e.g. `otacon tap e5`. */
  command: string
  /** Otacon subcommand verb, e.g. `tap`, `swipe`, `set-text`. */
  subcommand: string
  /** Target description (ref like `e5`, coords `540,1200`, or arg summary). */
  target: string
  /** The model's stated rationale for running this command. */
  rationale: string
  /** Epoch ms when the wrapper started capture. */
  started_at: number
  /** Epoch ms when the wrapper finished (after the after-screenshot). */
  completed_at: number
  /** Subprocess exit code from the otacon subcommand. */
  exit_code: number
  /** Subprocess stdout. */
  stdout: string
  /** Subprocess stderr. */
  stderr: string
  /** API URLs (relative — server-bound) for the captured screenshots. */
  screenshots: {
    before: string | null
    annotated: string | null
    after: string | null
  }
}

/**
 * Emit a `data-phone-action` chunk into the run's writable stream.
 *
 * Constructs the chunk id as a ULID so the timestamp is recoverable from the
 * id alone (per plan §"Stream timestamps are derivable from chunk id"). The
 * payload also carries `started_at`/`completed_at` for explicit start/end.
 */
export async function emitPhoneAction(payload: PhoneActionPayload): Promise<void> {
  const writer = getWritable<UIMessageChunk>().getWriter()
  try {
    await writer.write({
      type: 'data-phone-action',
      id: ulid(),
      data: payload,
    } as unknown as UIMessageChunk)
  } finally {
    writer.releaseLock()
  }
}

/**
 * Build the `screenshots` URL block for a given run + tool call. Returns
 * `null` for kinds that weren't captured. The URLs are relative paths under
 * the orchestrator HTTP base; the route handler at
 * `/api/v1/runs/{id}/traces/{tcid}/{file}` serves them in Phase 3.
 */
export function buildScreenshotUrls(
  runId: string,
  toolCallId: string,
  available: { before: boolean; annotated: boolean; after: boolean },
): PhoneActionPayload['screenshots'] {
  const base = `/api/v1/runs/${encodeURIComponent(runId)}/traces/${encodeURIComponent(toolCallId)}`
  return {
    before: available.before ? `${base}/before.png` : null,
    annotated: available.annotated ? `${base}/annotated.png` : null,
    after: available.after ? `${base}/after.png` : null,
  }
}
