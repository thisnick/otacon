import { ulid } from 'ulid'
import type { Db } from '../db/client.js'
import { accounts, accountCredentials } from '../db/schema.js'

export async function addAccountCommand(opts: {
  id: string
  phoneNumber?: string
  email?: string
  db: Db
}) {
  const { id, phoneNumber, email, db } = opts

  if (!phoneNumber && !email) {
    throw new Error('At least one credential required: --phone-number or --email')
  }

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

  const creds = [phoneNumber && `phone=${phoneNumber}`, email && `email=${email}`].filter(Boolean).join(', ')
  console.log(`Account "${id}" added (${creds})`)
}
