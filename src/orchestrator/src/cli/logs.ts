import { eq, desc, and, gte } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { activityLog, conversations } from '../db/schema.js'

export async function logsCommand(opts: {
  account: string
  since?: string
  db: Db
}) {
  const { account, since, db } = opts

  // Find conversations for this account
  const convos = await db
    .select()
    .from(conversations)
    .where(eq(conversations.conversationKey, `account:${account}:agent:engagement-lead`))

  if (convos.length === 0) {
    console.log('No conversations found for this account.')
    return
  }

  const convoIds = convos.map(c => c.id)

  let query = db
    .select()
    .from(activityLog)
    .where(
      and(
        // Filter by conversation IDs — use first one for now
        eq(activityLog.conversationId, convoIds[0]),
        since ? gte(activityLog.createdAt, parseSince(since)) : undefined,
      )
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(50)

  const logs = await query

  if (logs.length === 0) {
    console.log('No activity logs found.')
    return
  }

  console.log('Time                      Action              Target')
  console.log('─'.repeat(80))
  for (const log of logs) {
    const time = log.createdAt.toISOString().slice(0, 19).replace('T', ' ')
    const action = (log.actionType ?? '').padEnd(20)
    const target = (log.target ?? '').slice(0, 40)
    console.log(`${time}  ${action}${target}`)
  }
}

function parseSince(since: string): Date {
  const match = since.match(/^(\d+)(s|m|h|d)$/)
  if (!match) return new Date(since)
  const [, num, unit] = match
  const ms = parseInt(num) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]!
  return new Date(Date.now() - ms)
}
