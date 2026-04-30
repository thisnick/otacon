/**
 * `POST /api/v1/runs/:id/messages` — enqueue a user message for a running agent.
 *
 * Body: `{content: string}`. The orchestrator appends the message to the
 * run's inbox file (`runs/{id}/messages-inbox.jsonl`). At each agent
 * turn boundary the workflow body drains the inbox (in a step) and
 * prepends the messages to the next turn's `messages[]` array, so the
 * model sees them as fresh `role: 'user'` entries before generating the
 * next response.
 *
 * Why FS instead of a Workflow SDK hook: hooks suspend the workflow
 * until resumed. We want non-blocking injection so the agent keeps
 * looping while the user adds context. The inbox is a small queue the
 * workflow polls at safe boundaries.
 *
 * Idempotency: each message gets a fresh ULID even on retries — callers
 * who want dedup should set their own `Idempotency-Key`-style content
 * hash. (Not implemented here; no use case yet.)
 *
 * Returns `{message: InboxMessage}` (the persisted record incl. id + ts).
 */
import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import { z } from 'zod'
import { makeStores } from '../../../../../../src/storage/factory.js'

const Body = z.object({
  content: z.string().min(1, 'content must be non-empty'),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id', { decode: true })
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'missing run id' })
  }

  const raw = await readBody(event)
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: `invalid body: ${parsed.error.issues.map(i => i.message).join('; ')}`,
    })
  }

  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const { runStore } = await makeStores({ dataDir })
  const run = await runStore.get(id)
  if (!run) {
    throw createError({ statusCode: 404, statusMessage: `run ${id} not found` })
  }
  // Reject when the run is already terminal — there's no agent loop to
  // pick up the message.
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    throw createError({
      statusCode: 409,
      statusMessage: `run ${id} is ${run.status}; cannot accept new messages`,
    })
  }

  const message = await runStore.enqueueInboxMessage(id, parsed.data.content)
  return { message }
})
