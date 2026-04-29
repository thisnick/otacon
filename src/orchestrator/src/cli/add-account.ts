/**
 * `service add-account` — register a new account.
 *
 * During the orchestrator-v2 migration, this command writes to BOTH backends:
 *   - the existing Drizzle `accounts` + `account_credentials` tables (kept
 *     so the legacy team-runner / inspect / allocations flow keeps working)
 *   - the FS-backed AccountStore at ${ORCHESTRATOR_DATA_DIR}/accounts/<id>/
 *
 * Once all legacy callers (team-runner, allocations, inspect, logs, status)
 * are migrated to AccountStore, the Drizzle writes go away.
 *
 * The AccountStore write also bootstraps placeholder env files
 * (`env/persona.md`, `env/soul.md`, `env/agents.md`) for the agent's
 * read-only mounts. Existing files are NOT overwritten — re-running
 * `add-account` over an account whose env was edited preserves the edits.
 */
import { ulid } from 'ulid'
import type { Db } from '../db/client.js'
import { accounts, accountCredentials } from '../db/schema.js'
import { makeStores } from '../storage/factory.js'
import type { AccountStore } from '../storage/account-store.js'

const ENV_STUBS: Record<string, string> = {
  'persona.md': `# Persona

This file describes the account's persona — the personality the agent
projects when interacting with the platform. Edit freely.

(placeholder — replace with real persona content for this account)
`,
  'soul.md': `# Soul

Deeper personality and motivations behind the persona. The "why" behind the
"what". Edit freely.

(placeholder — replace with real soul content for this account)
`,
  'agents.md': `# Agents

Description of the team and roles operating this account. Surfaced to the
agent so it knows who it is and how it fits into the team.

(placeholder — replace with real team description for this account)
`,
}

export async function addAccountCommand(opts: {
  id: string
  phoneNumber?: string
  email?: string
  db: Db
  dataDir?: string
}) {
  const { id, phoneNumber, email, db } = opts

  if (!phoneNumber && !email) {
    throw new Error('At least one credential required: --phone-number or --email')
  }

  // 1. Drizzle writes (legacy path; team-runner / allocations / inspect read here)
  await db.insert(accounts).values({
    id,
    accountType: 'xhs',
    status: 'active',
    config: {},
  }).onConflictDoNothing()

  if (phoneNumber) {
    await db.insert(accountCredentials).values({
      id: ulid(),
      accountId: id,
      credentialType: 'phone',
      identifier: phoneNumber,
      isPrimary: true,
    }).onConflictDoNothing()
  }

  if (email) {
    await db.insert(accountCredentials).values({
      id: ulid(),
      accountId: id,
      credentialType: 'email',
      identifier: email,
      isPrimary: !phoneNumber,
    }).onConflictDoNothing()
  }

  // 2. FS writes (AccountStore — what the orchestrator-v2 server will read)
  const dataDir = opts.dataDir ?? process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { accountStore } = await makeStores({ dataDir })
  await accountStore.create({ id, accountType: 'xhs' })
  if (phoneNumber) {
    await accountStore.addCredential(id, {
      credentialType: 'phone',
      identifier: phoneNumber,
      isPrimary: true,
    })
  }
  if (email) {
    await accountStore.addCredential(id, {
      credentialType: 'email',
      identifier: email,
      isPrimary: !phoneNumber,
    })
  }
  await ensureEnvStubs(accountStore, id)
  await accountStore.ensureWorkspace(id)

  const creds = [phoneNumber && `phone=${phoneNumber}`, email && `email=${email}`].filter(Boolean).join(', ')
  console.log(`Account "${id}" added (${creds})`)
  console.log(`  FS: ${dataDir}/accounts/${id}/{account.json,credentials.json,env/,workspace/}`)
}

async function ensureEnvStubs(store: AccountStore, accountId: string): Promise<void> {
  for (const [relPath, content] of Object.entries(ENV_STUBS)) {
    const existing = await store.readEnvFile(accountId, relPath)
    if (existing === null) {
      await store.writeEnvFile(accountId, relPath, content)
    }
  }
}
