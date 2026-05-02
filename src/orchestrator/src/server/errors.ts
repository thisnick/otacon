/**
 * Standard error response envelope for the orchestrator API.
 *
 * Spec (docs/orchestrator-api.md): every 4xx/5xx response has shape
 *   { error: { code, message, details? } }
 *
 * `code` is a stable snake_case string the client switches on; `message`
 * is human-readable; `details` is optional structured context.
 */
import type { Context } from 'hono'

export type ErrorCode =
  | 'bad_request'
  | 'workspace_not_found'
  | 'team_not_found'
  | 'session_not_found'
  | 'escalation_not_found'
  | 'escalation_already_resolved'
  | 'workspace_kind_mismatch'
  | 'internal'

const STATUS: Record<ErrorCode, 400 | 404 | 409 | 500> = {
  bad_request: 400,
  workspace_not_found: 404,
  team_not_found: 404,
  session_not_found: 404,
  escalation_not_found: 404,
  escalation_already_resolved: 409,
  workspace_kind_mismatch: 409,
  internal: 500,
}

export function apiError(c: Context, code: ErrorCode, message: string, details?: unknown) {
  return c.json({ error: { code, message, details } }, STATUS[code])
}
