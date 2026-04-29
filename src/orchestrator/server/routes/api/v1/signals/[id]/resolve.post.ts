/**
 * `POST /api/v1/signals/:id/resolve` — resolve a pending signal (approval
 * or escalation), unblocking the workflow that's awaiting the hook.
 *
 * Body: `{ decision: 'approve' | 'reject' | 'skip', message?: string }`
 *
 * Flow:
 *   1. Look up the signal via SignalStore.get(:id) to get the hook token.
 *   2. Call `resumeHook(token, {decision, message})` — Workflow SDK
 *      delivers the payload to the suspended hook and the workflow
 *      resumes.
 *   3. Mark the signal resolved in SignalStore so list/UI no longer
 *      shows it as pending.
 *
 * If the signal is already resolved, we return the existing record
 * (idempotent — repeated resolve calls don't double-resume).
 */
import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import { resumeHook } from 'workflow/api'
import { z } from 'zod'
import { makeStores } from '../../../../../../src/storage/factory.js'

const ResolveBody = z.object({
  decision: z.enum(['approve', 'reject', 'skip']),
  message: z.string().optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'missing signal id' })
  }

  const raw = await readBody(event)
  const parsed = ResolveBody.safeParse(raw)
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: `invalid body: ${parsed.error.issues.map(i => i.message).join('; ')}`,
    })
  }
  const { decision, message } = parsed.data

  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { signalStore } = await makeStores({ dataDir })
  const signal = await signalStore.get(id)
  if (!signal) {
    throw createError({ statusCode: 404, statusMessage: `signal ${id} not found` })
  }

  if (signal.status !== 'pending') {
    // Idempotent re-resolve: return what's already there.
    return { ok: true, alreadyResolved: true, signal }
  }

  // Deliver the payload to the suspended hook. Workflow runtime resumes
  // from the saved state; the workflow body picks up after `await hook`.
  await resumeHook(signal.hookToken, { decision, message })

  const resolved = await signalStore.markResolved(id, decision, message)
  return { ok: true, alreadyResolved: false, signal: resolved }
})
