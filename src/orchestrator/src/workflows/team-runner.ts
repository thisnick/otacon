/**
 * Team runner: entry point that loads team config, finds/creates conversation,
 * builds sandbox, and dispatches to the durable agent workflow.
 */
import { eq, and } from 'drizzle-orm'
import { ulid } from 'ulid'
import { OtaconClient } from 'otacon-cli/client'
import type { Db } from '../db/client.js'
import { accounts, accountCredentials, conversations, agentInstances } from '../db/schema.js'
import { LocalBlobStore } from '../storage/blob.js'
import { buildSandbox } from '../sandbox/build.js'
import { buildSystemPrompt } from '../agents/build-prompt.js'
import { runDurableAgent } from './durable-agent.js'
import { resolvePhone } from '../resolve/phone.js'
import type { TeamConfig } from '../teams/social-media-engagement/config.js'

// Registry of known teams
import { socialMediaEngagement } from '../teams/social-media-engagement/config.js'

const TEAMS: Record<string, TeamConfig> = {
  'social-media-engagement': socialMediaEngagement,
}

export function getTeam(name: string): TeamConfig {
  const team = TEAMS[name]
  if (!team) throw new Error(`unknown team: ${name}. Available: ${Object.keys(TEAMS).join(', ')}`)
  return team
}

export interface RunTeamOptions {
  accountId: string
  teamName: string
  prompt?: string
  db: Db
  blobRoot?: string
}

export async function runTeam(opts: RunTeamOptions) {
  const { accountId, teamName, prompt, db, blobRoot = '.orchestrator-data/blobs' } = opts

  // 1. Load team config
  const team = getTeam(teamName)
  const leadConfig = team.agents.find(a => a.role === team.lead)
  if (!leadConfig) throw new Error(`lead agent "${team.lead}" not found in team config`)

  console.log(`[team] Loading team "${team.name}", lead agent "${leadConfig.role}"`)
  console.log(`[team] Model: ${leadConfig.model}, conversation: ${leadConfig.conversation}`)

  // 2. Load account + primary phone credential from DB
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1)
  if (!account) throw new Error(`account "${accountId}" not found. Run: pnpm orchestrator add-account --id ${accountId} ...`)

  // Find the primary phone credential for runtime resolution
  const [phoneCred] = await db
    .select()
    .from(accountCredentials)
    .where(and(
      eq(accountCredentials.accountId, accountId),
      eq(accountCredentials.credentialType, 'phone'),
    ))
    .limit(1)
  if (!phoneCred) throw new Error(`account "${accountId}" has no phone credential. Run: pnpm orchestrator add-account --id ${accountId} --phone-number ...`)

  console.log(`[team] Account: ${account.id}, phone: ${phoneCred.identifier}`)

  // 3. Find or create conversation
  const conversationKey = `account:${accountId}:agent:${leadConfig.role}`
  let [convo] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.conversationKey, conversationKey), eq(conversations.status, 'active')))
    .limit(1)

  if (!convo) {
    const convoId = ulid()
    const blobPath = `conversations/${convoId}`
    await db.insert(conversations).values({
      id: convoId,
      conversationKey,
      blobPath,
      status: 'active',
    })
    ;[convo] = await db.select().from(conversations).where(eq(conversations.id, convoId)).limit(1)
    console.log(`[team] Created new conversation: ${convoId}`)
  } else {
    console.log(`[team] Resuming conversation: ${convo.id}`)
  }

  // 4. Create/update agent instance
  const instanceId = ulid()
  await db.insert(agentInstances).values({
    id: instanceId,
    conversationId: convo!.id,
    teamName: team.name,
    agentRole: leadConfig.role,
    status: 'running',
  }).onConflictDoUpdate({
    target: [agentInstances.conversationId, agentInstances.agentRole],
    set: {
      status: 'running',
      updatedAt: new Date(),
    },
  })

  // 5. Resolve phone → host at runtime via registry
  console.log(`[team] Resolving phone number ${phoneCred.identifier} via registry...`)
  const resolved = await resolvePhone(phoneCred.identifier)
  console.log(`[team] Resolved to ${resolved.phoneId} at ${resolved.baseUrl}`)

  const client = new OtaconClient(resolved.baseUrl)
  const blobStore = new LocalBlobStore(blobRoot)

  const bash = buildSandbox({
    client,
    blobStore,
    accountId,
  })

  const systemPrompt = await buildSystemPrompt({
    teamName: team.name,
    promptFile: leadConfig.promptFile,
    accountId,
  })

  console.log(`[team] Sandbox ready, starting agent...`)

  // 6. Run the durable agent
  try {
    await runDurableAgent({
      conversationId: convo!.id,
      accountId,
      phoneId: resolved.phoneId,
      model: leadConfig.model,
      systemPrompt,
      bash,
      blobStore,
      db,
      client,
      initialPrompt: prompt,
    })
  } finally {
    // Update agent instance status
    try {
      await db
        .update(agentInstances)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(agentInstances.id, instanceId))
    } catch {}
  }
}
