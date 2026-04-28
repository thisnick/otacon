import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { agentInstances, accounts } from '../db/schema.js'

export async function statusCommand(opts: { db: Db }) {
  const { db } = opts

  const instances = await db
    .select()
    .from(agentInstances)
    .where(eq(agentInstances.status, 'running'))

  const allAccounts = await db.select().from(accounts)

  console.log('=== Accounts ===')
  if (allAccounts.length === 0) {
    console.log('(none)')
  } else {
    console.log('ID                  Type            Status')
    console.log('─'.repeat(60))
    for (const a of allAccounts) {
      console.log(`${a.id.padEnd(20)}${a.accountType.padEnd(16)}${a.status}`)
    }
  }

  console.log('\n=== Running Agents ===')
  if (instances.length === 0) {
    console.log('(none)')
  } else {
    console.log('Team                      Role                Status    Started')
    console.log('─'.repeat(80))
    for (const inst of instances) {
      const team = inst.teamName.padEnd(26)
      const role = inst.agentRole.padEnd(20)
      const status = inst.status.padEnd(10)
      const started = inst.startedAt.toISOString().slice(0, 19).replace('T', ' ')
      console.log(`${team}${role}${status}${started}`)
    }
  }
}
