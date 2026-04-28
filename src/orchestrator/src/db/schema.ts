import { pgTable, text, timestamp, jsonb, unique, boolean } from 'drizzle-orm/pg-core'

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  displayName: text('display_name'),
  accountType: text('account_type').notNull().default('xhs'),
  status: text('status').notNull().default('active'),
  config: jsonb('config').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const accountCredentials = pgTable('account_credentials', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  credentialType: text('credential_type').notNull(),
  identifier: text('identifier').notNull(),
  secrets: jsonb('secrets'),
  isPrimary: boolean('is_primary').default(false),
  verified: boolean('verified').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('uq_credential_type_identifier').on(table.credentialType, table.identifier),
])

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  conversationKey: text('conversation_key').notNull(),
  blobPath: text('blob_path').notNull(),
  status: text('status').notNull().default('active'),
  compactedFrom: text('compacted_from'),
  summaryBlobPath: text('summary_blob_path'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const agentInstances = pgTable('agent_instances', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  teamName: text('team_name').notNull(),
  agentRole: text('agent_role').notNull(),
  workflowId: text('workflow_id'),
  hookToken: text('hook_token'),
  status: text('status').notNull().default('created'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('uq_conversation_role').on(table.conversationId, table.agentRole),
])

export const activityLog = pgTable('activity_log', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  sessionId: text('session_id').notNull(),
  actionType: text('action_type').notNull(),
  target: text('target'),
  details: jsonb('details').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const agentSignals = pgTable('agent_signals', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  signalType: text('signal_type').notNull(),
  hookToken: text('hook_token').notNull(),
  status: text('status').notNull().default('pending'),
  payload: jsonb('payload'),
  resolution: jsonb('resolution'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
})
