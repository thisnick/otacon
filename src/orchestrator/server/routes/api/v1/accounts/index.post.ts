/**
 * `POST /api/v1/accounts` — create an account (idempotent).
 *
 * Body: `{id, displayName?, accountType?, status?, config?, phoneNumber?}`.
 * `id` is required and must satisfy `assertSafeId`. If an account with
 * that id already exists, returns the existing record (200) — same
 * idempotency model as `AccountStore.create`.
 *
 * If `phoneNumber` is in the body we also append a credential row
 * `{credentialType: 'phone', identifier: phoneNumber}` so the registry
 * resolver can find the phone for `otacon-alloc provision`.
 */
import { defineEventHandler, readBody, createError } from 'h3'
import { makeStores } from '../../../../../src/storage/factory.js'
import { assertSafeId } from '../../../../../src/storage/paths.js'
import type { AccountInput } from '../../../../../src/storage/types.js'

interface Body extends AccountInput {
  /** Optional convenience: also write a `phone` credential row. */
  phoneNumber?: string
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<Body>(event)) ?? ({} as Body)
  if (!body.id) {
    throw createError({ statusCode: 400, statusMessage: 'missing required field: id' })
  }
  try {
    assertSafeId(body.id)
  } catch (e) {
    throw createError({ statusCode: 400, statusMessage: (e as Error).message })
  }

  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { accountStore } = await makeStores({ dataDir })
  const account = await accountStore.create({
    id: body.id,
    displayName: body.displayName,
    accountType: body.accountType,
    status: body.status,
    config: body.config,
  })

  // Optional phone credential — added only if not already present.
  if (typeof body.phoneNumber === 'string' && body.phoneNumber !== '') {
    const existing = await accountStore.listCredentials(account.id)
    const has = existing.some(c => c.credentialType === 'phone' && c.identifier === body.phoneNumber)
    if (!has) {
      await accountStore.addCredential(account.id, {
        credentialType: 'phone',
        identifier: body.phoneNumber,
      })
    }
  }

  return { account }
})
