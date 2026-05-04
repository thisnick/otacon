// Wire-format types consumed by the web UI.
//
// These mirror `src/orchestrator/src/types.ts` but live here so the browser
// bundle doesn't pull in the server tree. If the server's wire format
// changes, update this file in lockstep with the spec at
// docs/orchestrator-api.md.

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

// AgentEvent comes from @mariozechner/pi-agent-core; we keep it loose here
// (the renderer dispatches on `type`) to avoid a hard browser dep on the
// agent-core package.
export interface AgentEventBase {
  type: string
  [k: string]: unknown
}

export type OtaconEvent =
  | { kind: 'pi'; event: AgentEventBase; ts: number }
  | { kind: 'user_message'; text: string; ts: number }
  | { kind: 'system_set'; prompt: string; ts: number }
  | { kind: 'phone_action'; payload: PhoneActionPayload; ts: number }
  | {
      kind: 'escalation_requested'
      token: string
      payload: EscalationPayload
      ts: number
    }
  | {
      kind: 'escalation_resolved'
      token: string
      decision: 'approve' | 'reject'
      message?: string
      ts: number
    }

export interface WorkspaceSummary {
  id: string
  displayName: string
  kind: string
  phoneNumber?: string
  externalRef?: string
  createdAt: number
}

export interface Workspace extends WorkspaceSummary {
  phoneNumber: string
}

export interface CreateWorkspaceRequest {
  id: string
  displayName: string
  kind: 'social'
  phoneNumber: string
  externalRef?: string
  forcePhoneNumber?: boolean
}

export type PatchWorkspaceRequest = Partial<
  Pick<Workspace, 'displayName' | 'phoneNumber' | 'externalRef' | 'kind'>
>

export interface EnvFileMeta {
  name: string
  size: number
  modifiedAt: number
}

export interface CredentialsStatus {
  hasCredentials: boolean
  fieldsSet: string[]
}

export interface TeamAgent {
  role: string
  model: string
  promptFile: string
}

export interface Team {
  name: string
  description: string
  expectedWorkspaceKind: string
  lead: string
  agents: TeamAgent[]
}

export type TeamSummary = Team

export interface CreateTeamRequest {
  name: string
  description: string
  expectedWorkspaceKind: string
  lead?: string
}

export interface PatchTeamRequest {
  description?: string
  expectedWorkspaceKind?: string
  lead?: string
  agents?: Array<{ role: string; model: string }>
}

export interface PhoneEntry {
  phoneNumber: string
  status: 'online' | 'offline' | 'unreachable'
  registryId: string
  displayLabel: string
  hostId: string
}

export type SessionStatus = 'running' | 'completed' | 'aborted' | 'error'

export interface SessionSummary {
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

export interface StartRunRequest {
  workspace: string
  team: string
  userMessage: string
  resume?: 'last' | 'new' | string
  autoApprove?: boolean
  autoReject?: boolean
  modelProvider?: string
}

export interface ResolveEscalationRequest {
  decision: 'approve' | 'reject'
  message?: string
}

export interface ApiError {
  error: {
    code: string
    message: string
    details?: unknown
  }
}
