/**
 * `GET /health` — liveness probe.
 *
 * Returns `{ok: true}` once the Nitro server is up and the world plugin
 * has booted. Used by the e2e suite to wait for server readiness and
 * by external monitors to confirm the orchestrator is alive.
 */
import { defineEventHandler } from 'h3'

export default defineEventHandler(() => {
  return { ok: true }
})
