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
  | 'workspace_already_exists'
  | 'team_already_exists'
  | 'workspace_has_sessions'
  | 'env_file_not_found'
  | 'no_default_for_file'
  | 'no_default_for_team'
  | 'agent_role_not_found'
  | 'phone_unresolvable'
  | 'phones_unavailable'
  | 'internal'

const STATUS: Record<ErrorCode, 400 | 404 | 409 | 500 | 502> = {
  bad_request: 400,
  workspace_not_found: 404,
  team_not_found: 404,
  session_not_found: 404,
  escalation_not_found: 404,
  escalation_already_resolved: 409,
  workspace_kind_mismatch: 409,
  workspace_already_exists: 409,
  team_already_exists: 409,
  workspace_has_sessions: 409,
  env_file_not_found: 404,
  no_default_for_file: 404,
  no_default_for_team: 404,
  agent_role_not_found: 404,
  phone_unresolvable: 400,
  phones_unavailable: 502,
  internal: 500,
}

export function apiError(c: Context, code: ErrorCode, message: string, details?: unknown) {
  return c.json({ error: { code, message, details } }, STATUS[code])
}
