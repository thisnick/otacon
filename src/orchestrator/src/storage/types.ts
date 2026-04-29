/**
 * Shared types for the FS-backed storage layer.
 *
 * These are the persisted shapes — what lives in JSON files on disk. They are
 * intentionally narrow; richer in-memory views (e.g. AllocationContext, run
 * timeline) are built on top of them but not stored verbatim.
 */

export type AccountStatus = 'active' | 'paused' | 'archived'

export interface Account {
  id: string
  displayName: string | null
  accountType: string
  status: AccountStatus
  config: Record<string, unknown>
  createdAt: number
}

export interface AccountInput {
  id: string
  displayName?: string | null
  accountType?: string
  status?: AccountStatus
  config?: Record<string, unknown>
}

export type CredentialType = 'phone' | 'email' | string

export interface Credential {
  id: string
  credentialType: CredentialType
  identifier: string
  isPrimary: boolean
  verified: boolean
  secrets: Record<string, unknown> | null
  createdAt: number
}

export interface CredentialInput {
  credentialType: CredentialType
  identifier: string
  isPrimary?: boolean
  verified?: boolean
  secrets?: Record<string, unknown> | null
}

export interface AgentConfig {
  role: string
  promptFile: string
  model: string
  conversation: 'persistent' | 'ephemeral'
}

export interface TeamConfig {
  name: string
  description: string
  lead: string
  agents: AgentConfig[]
}

export interface TeamMeta {
  name: string
  description: string
  lead: string
}

export type RunStatus = 'created' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Run {
  id: string
  workflowRunId: string | null
  account: string
  team: string
  agentRole: string
  model: string
  promptTemplatePaths: string[]
  promptSnapshotPath: string | null
  initialPrompt: string | null
  status: RunStatus
  startedAt: number
  completedAt: number | null
  finalText: string | null
  error: string | null
  turnCount: number
}

export interface RunInput {
  id: string
  workflowRunId?: string | null
  account: string
  team: string
  agentRole: string
  model: string
  promptTemplatePaths?: string[]
  promptSnapshotPath?: string | null
  initialPrompt?: string | null
}

export interface ListRunsOpts {
  account?: string
  team?: string
  status?: RunStatus
  limit?: number
  beforeId?: string
}

/** Thin shape persisted in `index/runs.jsonl` for fast list queries. */
export interface RunIndexEntry {
  id: string
  account: string
  team: string
  status: RunStatus
  startedAt: number
  completedAt: number | null
}

export type SignalKind = 'approval' | 'escalation' | 'user_message'
export type SignalStatus = 'pending' | 'approved' | 'rejected' | 'skipped'

export interface Signal {
  id: string
  runId: string
  kind: SignalKind
  status: SignalStatus
  hookToken: string
  toolCallId: string | null
  command: string | null
  rationale: string | null
  screenshotPath: string | null
  createdAt: number
  resolvedAt: number | null
  decision: 'approve' | 'reject' | 'skip' | null
  message: string | null
  payload: Record<string, unknown>
}

export interface SignalInput {
  runId: string
  kind: SignalKind
  hookToken: string
  toolCallId?: string | null
  command?: string | null
  rationale?: string | null
  screenshotPath?: string | null
  payload?: Record<string, unknown>
  /** Optional pre-assigned id — when omitted the store generates a ULID. */
  id?: string
}

/**
 * Persisted phone-allocation row. Replaces the Drizzle `phoneAllocations` table.
 * `expiresAt` is a unix-ms timestamp (number) so it round-trips cleanly through
 * JSON. `phoneId` is the registry phone ID — see feedback_dual_id_system.md.
 */
export interface AllocationRow {
  allocationId: string
  phoneId: string
  conversationId: string
  allocatedAt: number
  expiresAt: number
}

export interface AllocationsFile {
  version: 1
  rows: AllocationRow[]
}
