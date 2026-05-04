/**
 * Domain types for the Pi spike.
 *
 * `OtaconEvent` is a discriminated union: Pi's native `AgentEvent` is
 * wrapped in `{kind: 'pi', event}`; everything else is custom. Two
 * persisters (messages.jsonl + events.jsonl) subscribe independently to
 * the same SessionBus.
 */
import type { AgentEvent } from '@mariozechner/pi-agent-core'

export interface ScreenshotTriple {
  before: string | null
  annotated: string | null
  after: string | null
}

export interface PhoneActionPayload {
  toolCallId: string
  command: string
  subcommand: string
  target: string
  rationale: string
  startedAt: number
  completedAt: number
  exitCode: number
  stdout: string
  stderr: string
  screenshots: ScreenshotTriple
}

export interface EscalationPayload {
  prompt: string
  details?: unknown
}

export type OtaconEvent =
  | { kind: 'pi'; event: AgentEvent; ts: number }
  | { kind: 'user_message'; text: string; ts: number }
  | { kind: 'system_set'; prompt: string; ts: number }
  | { kind: 'phone_action'; payload: PhoneActionPayload; ts: number }
  | { kind: 'escalation_requested'; token: string; payload: EscalationPayload; ts: number }
  | {
      kind: 'escalation_resolved'
      token: string
      decision: 'approve' | 'reject'
      message?: string
      ts: number
    }

export type WorkspaceKind = 'social' | string

export interface Workspace {
  id: string
  displayName: string
  kind: WorkspaceKind
  /**
   * E.164 phone number. Required for new workspaces (Phase I); optional in
   * the type for back-compat with pre-Phase-I `workspace.json` files. Run-
   * time phone resolution via `resolvePhone()` rejects if missing.
   */
  phoneNumber?: string
  externalRef?: string
  createdAt: number
}

export interface AgentRoleConfig {
  role: string
  promptFile: string
  model: string
}

export interface Team {
  name: string
  description: string
  expectedWorkspaceKind: WorkspaceKind
  lead: string
  agents: AgentRoleConfig[]
}

export type SessionStatus = 'running' | 'completed' | 'aborted' | 'error'

export interface SessionMeta {
  id: string
  workspace: string
  team: string
  agentRole: string
  modelProvider: string
  modelId: string
  startedAt: number
  endedAt: number | null
  status: SessionStatus
  error?: string | null
}
