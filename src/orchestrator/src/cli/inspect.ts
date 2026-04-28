/**
 * Inspect commands: read-only views over conversations, allocations,
 * agents, activity logs, schema, and the bash command registry.
 */
import { eq, desc, and, gte, like, sql } from 'drizzle-orm'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Db } from '../db/client.js'
import {
  accounts,
  agentInstances,
  activityLog,
  conversations,
  phoneAllocations,
} from '../db/schema.js'
import { LocalBlobStore } from '../storage/blob.js'
import { loadConversation } from '../storage/conversation.js'
import { otaconRegistry } from 'otacon-cli/commands/otacon'
import { buildAllocRegistry } from '../sandbox/alloc-commands.js'

const BLOB_ROOT = '.orchestrator-data/blobs'

/** `inspect conversations [--account <id>]` */
export async function inspectConversationsCommand(opts: { db: Db; account?: string }) {
  const { db, account } = opts

  let convos
  if (account) {
    convos = await db
      .select()
      .from(conversations)
      .where(like(conversations.conversationKey, `account:${account}:%`))
      .orderBy(desc(conversations.updatedAt))
  } else {
    convos = await db
      .select()
      .from(conversations)
      .orderBy(desc(conversations.updatedAt))
  }

  if (convos.length === 0) {
    console.log('(no conversations)')
    return
  }

  if (account) console.log(`Account: ${account}`)
  console.log('Conversations:')

  for (const c of convos) {
    let msgCount = 0
    try {
      const store = new LocalBlobStore(BLOB_ROOT)
      const files = await store.list(`${c.blobPath}/messages`)
      msgCount = files.filter(f => f.endsWith('.json')).length
    } catch {}

    const last = c.updatedAt.toISOString().slice(0, 19).replace('T', ' ')
    const status = c.status.padEnd(12)
    console.log(`  ${c.conversationKey.padEnd(50)} ${status} ${String(msgCount).padStart(4)} msgs   updated ${last}`)
  }
}

/** `inspect conversation <conversation_id>` */
export async function inspectConversationCommand(opts: {
  db: Db
  conversationId: string
}) {
  const { db, conversationId } = opts

  const [convo] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)

  if (!convo) {
    console.error(`conversation "${conversationId}" not found`)
    process.exit(1)
  }

  const store = new LocalBlobStore(BLOB_ROOT)
  const messages = await loadConversation(store, conversationId)

  const tracesDir = path.join(BLOB_ROOT, convo.blobPath, 'traces')
  let toolCallToFiles: Map<string, string[]> = new Map()
  try {
    const dirs = await fs.readdir(tracesDir, { withFileTypes: true })
    for (const dir of dirs) {
      if (dir.isDirectory()) {
        const files = await fs.readdir(path.join(tracesDir, dir.name))
        toolCallToFiles.set(
          dir.name,
          files.filter(f => f.endsWith('.png') || f.endsWith('.json')).sort(),
        )
      }
    }
  } catch {}

  // Build markdown
  const lines: string[] = []
  lines.push(`# Conversation: ${convo.conversationKey}`)
  lines.push('')
  lines.push(`**ID**: \`${convo.id}\`  `)
  lines.push(`**Status**: ${convo.status}  `)
  lines.push(`**Started**: ${convo.createdAt.toISOString()}  `)
  lines.push(`**Updated**: ${convo.updatedAt.toISOString()}  `)
  lines.push(`**Messages**: ${messages.length}`)
  lines.push('')

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as any
    const role = msg.role
    const ts = ''

    if (role === 'user') {
      const text = extractText(msg.content)
      lines.push(`## [${ts}] User`)
      lines.push('')
      for (const line of text.split('\n')) lines.push(`> ${line}`)
      lines.push('')
      continue
    }

    if (role === 'assistant') {
      lines.push(`## [${ts}] Assistant`)
      lines.push('')
      const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
      for (const part of parts) {
        if ((part as any).type === 'text' && (part as any).text) {
          lines.push((part as any).text)
          lines.push('')
        } else if ((part as any).type === 'tool-call') {
          const toolName = (part as any).toolName
          const toolCallId = (part as any).toolCallId
          const args = (part as any).args ?? (part as any).input
          lines.push(`### Tool call: ${toolName} (\`${toolCallId}\`)`)
          if (args?.command) lines.push(`\n\`\`\`bash\n$ ${args.command}\n\`\`\`\n`)
          if (args?.rationale) lines.push(`*Rationale*: ${args.rationale}`)
          // Reference matching trace files
          if (toolCallId && toolCallToFiles.has(toolCallId)) {
            const files = toolCallToFiles.get(toolCallId)!
            const pngs = files.filter(f => f.endsWith('.png'))
            for (const png of pngs) {
              const rel = `../traces/${toolCallId}/${png}`
              lines.push(`![${png}](${rel})`)
              lines.push('')
            }
          }
        }
      }
      continue
    }

    if (role === 'tool') {
      const parts = Array.isArray(msg.content) ? msg.content : [msg.content]
      for (const part of parts) {
        if ((part as any).type === 'tool-result') {
          const output = typeof (part as any).output === 'string'
            ? (part as any).output
            : JSON.stringify((part as any).output)
          lines.push(`**Output**:`)
          lines.push('```')
          lines.push(output.slice(0, 4000))
          lines.push('```')
          lines.push('')
        }
      }
    }
  }

  // Save report under conversation's blob_path
  const reportTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const reportRelPath = `${convo.blobPath}/reports/${reportTs}.md`
  const fullReportPath = path.join(BLOB_ROOT, reportRelPath)
  await fs.mkdir(path.dirname(fullReportPath), { recursive: true })
  await fs.writeFile(fullReportPath, lines.join('\n'))

  console.log(`Report written to: ${fullReportPath}`)
  console.log(`(${messages.length} messages, ${toolCallToFiles.size} traced tool calls)`)
}

function extractText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(p => (p?.type === 'text' ? p.text : JSON.stringify(p))).join('\n')
  }
  return JSON.stringify(content)
}

/** `inspect state [--account <id>]` */
export async function inspectStateCommand(opts: { db: Db; account?: string }) {
  const { db, account } = opts

  // Allocations: latest non-expired per phone
  const allocsRaw = await db.execute(sql`
    SELECT a.id, a.phone_id, a.conversation_id, a.allocated_at, a.expires_at, c.conversation_key
    FROM phone_allocations a
    JOIN conversations c ON c.id = a.conversation_id
    WHERE a.expires_at > now()
    ORDER BY a.allocated_at DESC
  `)
  const allocs = ((allocsRaw as any).rows ?? allocsRaw) as any[]

  // Filter by account
  const filteredAllocs = account
    ? allocs.filter(a => a.conversation_key.startsWith(`account:${account}:`))
    : allocs

  console.log(account ? `Account: ${account}` : 'All accounts')

  console.log('\nActive allocations:')
  if (filteredAllocs.length === 0) {
    console.log('  (none)')
  } else {
    for (const a of filteredAllocs) {
      const exp = new Date(a.expires_at)
      const remaining = Math.max(0, Math.floor((exp.getTime() - Date.now()) / 1000))
      console.log(`  ${a.phone_id.padEnd(12)} convo=${a.conversation_id} expires ${exp.toISOString().slice(11, 19)} (${remaining}s remaining)`)
    }
  }

  // Active agents
  const runningAgents = await db.select().from(agentInstances).where(eq(agentInstances.status, 'running'))
  console.log('\nRunning agents:')
  if (runningAgents.length === 0) {
    console.log('  (none)')
  } else {
    for (const inst of runningAgents) {
      const updated = inst.updatedAt.toISOString().slice(11, 19)
      console.log(`  ${inst.agentRole.padEnd(20)} workflow=${inst.workflowId ?? '(none)'} ${inst.status} updated ${updated}`)
    }
  }

  // Recent activity log
  console.log('\nRecent activity:')
  let recent
  if (account) {
    recent = await db.execute(sql`
      SELECT al.created_at, al.action_type, al.target
      FROM activity_log al
      JOIN conversations c ON c.id = al.conversation_id
      WHERE c.conversation_key LIKE ${`account:${account}:%`}
      ORDER BY al.created_at DESC
      LIMIT 10
    `)
  } else {
    recent = await db
      .select()
      .from(activityLog)
      .orderBy(desc(activityLog.createdAt))
      .limit(10)
  }
  const recentRows = ((recent as any).rows ?? recent) as any[]
  if (recentRows.length === 0) {
    console.log('  (none)')
  } else {
    for (const r of recentRows) {
      const ts = new Date(r.created_at ?? r.createdAt).toISOString().slice(11, 19)
      const action = r.action_type ?? r.actionType ?? '?'
      const target = (r.target ?? '').slice(0, 60)
      console.log(`  ${ts}  ${String(action).padEnd(24)} ${target}`)
    }
  }
}

/** `inspect schema` */
export async function inspectSchemaCommand(opts: { db: Db }) {
  const { db } = opts
  const result = await db.execute(sql`
    SELECT table_name,
           (SELECT count(*) FROM information_schema.columns c
            WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS col_count
    FROM information_schema.tables t
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY table_name
  `)
  const rows = ((result as any).rows ?? result) as any[]
  console.log('Tables:')
  for (const r of rows) {
    console.log(`  ${String(r.table_name).padEnd(28)} ${r.col_count} columns`)
  }
}

/** `inspect commands` */
export async function inspectCommandsCommand() {
  console.log('# otacon (phone control)')
  console.log('')
  for (const name of Object.keys(otaconRegistry).sort()) {
    const spec = otaconRegistry[name]
    console.log(`## ${spec.name}`)
    console.log(`  ${spec.description}`)
    console.log(`  usage:    ${spec.usage}`)
    console.log(`  mutating: ${spec.isMutating}`)
    if (spec.examples.length > 0) {
      console.log(`  examples:`)
      for (const ex of spec.examples) console.log(`    ${ex}`)
    }
    console.log('')
  }
  console.log('# otacon-alloc (phone allocation)')
  console.log('')
  const placeholderRegistry = buildAllocRegistry({
    db: null as any,
    accountId: '',
    conversationId: '',
    allocCtx: { peek: () => null, get: () => null, set: () => {}, clear: () => {} } as any,
  })
  for (const name of Object.keys(placeholderRegistry).sort()) {
    const spec = placeholderRegistry[name]
    console.log(`## ${spec.name}`)
    console.log(`  ${spec.description}`)
    console.log(`  usage: ${spec.usage}`)
    if (spec.examples.length > 0) {
      console.log(`  examples:`)
      for (const ex of spec.examples) console.log(`    ${ex}`)
    }
    console.log('')
  }
}

/** `inspect logs --account <id> [--since <dur>]` (replaces top-level `logs`) */
export async function inspectLogsCommand(opts: {
  db: Db
  account: string
  since?: string
}) {
  const { db, account, since } = opts

  const convos = await db
    .select()
    .from(conversations)
    .where(like(conversations.conversationKey, `account:${account}:%`))

  if (convos.length === 0) {
    console.log('No conversations found for this account.')
    return
  }

  const convoIds = convos.map(c => c.id)
  // Use IN clause via raw SQL since drizzle's `.in()` is awkward here
  const result = await db.execute(sql.raw(`
    SELECT created_at, action_type, target
    FROM activity_log
    WHERE conversation_id = ANY(ARRAY[${convoIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',')}])
      ${since ? `AND created_at >= '${parseSinceIso(since)}'` : ''}
    ORDER BY created_at DESC
    LIMIT 50
  `))
  const rows = ((result as any).rows ?? result) as any[]

  if (rows.length === 0) {
    console.log('No activity logs found.')
    return
  }

  console.log('Time                      Action                Target')
  console.log('─'.repeat(80))
  for (const r of rows) {
    const time = new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ')
    const action = String(r.action_type ?? '').padEnd(22)
    const target = String(r.target ?? '').slice(0, 40)
    console.log(`${time}  ${action}${target}`)
  }
}

function parseSinceIso(since: string): string {
  const match = since.match(/^(\d+)(s|m|h|d)$/)
  if (!match) return new Date(since).toISOString()
  const [, num, unit] = match
  const ms = parseInt(num) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]!
  return new Date(Date.now() - ms).toISOString()
}
