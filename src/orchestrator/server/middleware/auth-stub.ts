/**
 * Auth-stub middleware — reserved bearer-token plumbing, no enforcement.
 *
 * Reads the `Authorization: Bearer <token>` header on every incoming
 * request and parks it in `event.context.authToken` so downstream
 * handlers + future enforcement code can find it without re-parsing.
 *
 * Enforcement is gated by `ORCHESTRATOR_AUTH_REQUIRED=1` (Phase 5
 * deploy flag). When unset (the default), every request passes through
 * regardless of token presence — this is the dev-mode behavior
 * deliberately matching the plan's "URL config now, token deferred"
 * decision (see `src/config.ts`).
 *
 * When set, requests without a valid bearer token receive a 401. The
 * "valid" predicate is currently a presence check (any non-empty token
 * passes); Phase 5 will swap it for a proper token verifier (signature
 * check or HMAC).
 *
 * Internal `__test/` and `health` routes bypass this check entirely so
 * the e2e test suite + load balancer probes don't need tokens.
 */
import { defineEventHandler, getHeader, getRequestPath, createError } from 'h3'

const BYPASS_PREFIXES = ['/__test/', '/health']

export default defineEventHandler((event) => {
  const path = getRequestPath(event)
  if (BYPASS_PREFIXES.some(p => path.startsWith(p))) return

  const auth = getHeader(event, 'authorization') ?? ''
  const match = auth.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]

  // Park the parsed token for downstream + future enforcement.
  ;(event.context as Record<string, unknown>).authToken = token

  // Enforcement is OFF by default. Phase 5 deploy flips this flag.
  if (process.env.ORCHESTRATOR_AUTH_REQUIRED === '1') {
    if (!token) {
      throw createError({
        statusCode: 401,
        statusMessage: 'missing or malformed Authorization: Bearer <token> header',
      })
    }
    // TODO Phase 5: verify token signature / lookup against a token store.
    // For now any non-empty bearer satisfies the gate.
  }
})
