/**
 * `service add-account` — register a new account in the FS-backed
 * AccountStore.
 *
 * Writes to `${ORCHESTRATOR_DATA_DIR}/accounts/<id>/` :
 *   - `account.json`
 *   - `credentials.json`
 *   - `env/{persona,soul,agents}.md` placeholders (only if missing —
 *      re-running preserves user edits)
 *   - `workspace/` (mountpoint for the agent sandbox)
 */
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
  dataDir?: string
}) {
  const { id, phoneNumber, email } = opts

  if (!phoneNumber && !email) {
    throw new Error('At least one credential required: --phone-number or --email')
  }

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
