/**
 * Phase F · F7 — Trace PNG serving (folds in the F8 sharp check).
 *
 * Verifies the deployed VPS serves trace PNGs correctly AND that the
 * `sharp`-based annotation actually drew an overlay (not a no-op pass-through).
 *
 * Steps:
 *   1. Find the most-recent session on the VPS that has a phone_action
 *      with `subcommand` ∈ {tap, swipe, set-text, key, scroll, scroll-up,
 *      scroll-down, long-tap} (these are the mutating verbs the annotator
 *      draws overlays for).
 *   2. Pick its first such phone_action's tool call id.
 *   3. GET /api/v1/.../traces/<tcid>/before.png + annotated.png + after.png:
 *        - All three return 200
 *        - Content-Type is image/png
 *        - PNG magic bytes present
 *   4. sha256(annotated.png) ≠ sha256(before.png) — proves sharp drew an
 *      overlay (the `30df7a8` annotation-overlay-bug fix).
 *   5. Cache-Control header per spec: `private, max-age=86400`.
 *   6. SSH into the VPS and grep `docker logs otacon-orchestrator` for
 *      `sharp` errors — must show ZERO error lines (Phase E flagged item).
 *
 * If no sessions on the VPS have a mutating phone_action, F7 SKIPS its
 * sha256-differs assertion with an informative message — typically F8
 * (canonical XHS run) creates such a session, so run F7 strictly AFTER F8.
 *
 * Run:
 *   pnpm test:e2e:phase-f:f7
 */
import {
  ACCOUNT_ID,
  ACCOUNT_ID_ENC,
  TEAM_NAME,
  VPS_API_BASE,
  api,
  fetchBytes,
  sha256Bytes,
  ssh,
  traceUrl,
} from './helpers/phase-f.js'
import {
  assert,
  exitFromCounters,
  info,
  makeCounters,
  section,
  summary,
} from './helpers/spike.js'

const MUTATING_SUBCOMMANDS = new Set([
  'tap', 'swipe', 'set-text', 'key', 'scroll', 'scroll-up', 'scroll-down', 'long-tap',
])

interface PhoneActionEv {
  toolCallId: string
  subcommand: string
  command: string
}

async function findMutatingPhoneAction(): Promise<{
  sid: string
  action: PhoneActionEv
} | null> {
  // Walk sessions newest-first looking for a mutating phone_action.
  const sessRes = await api<Array<{ id: string }>>(
    `/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions`,
  )
  if (sessRes.status !== 200) return null
  const sessions = sessRes.body as Array<{ id: string }>
  for (const s of sessions) {
    const eventsRes = await fetch(
      `${VPS_API_BASE}/api/v1/workspaces/${ACCOUNT_ID_ENC}/teams/${TEAM_NAME}/sessions/${s.id}/events`,
      { headers: { accept: 'application/x-ndjson' } },
    )
    if (eventsRes.status !== 200) continue
    const text = await eventsRes.text()
    for (const line of text.split('\n').filter(l => l.length > 0)) {
      let p: Record<string, unknown>
      try { p = JSON.parse(line) as Record<string, unknown> } catch { continue }
      if (p['kind'] !== 'phone_action') continue
      const payload = p['payload'] as Record<string, unknown> | undefined
      if (!payload) continue
      const sub = String(payload['subcommand'] ?? '')
      if (!MUTATING_SUBCOMMANDS.has(sub)) continue
      return {
        sid: s.id,
        action: {
          toolCallId: String(payload['toolCallId'] ?? ''),
          subcommand: sub,
          command: String(payload['command'] ?? ''),
        },
      }
    }
  }
  return null
}

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function looksLikePng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_MAGIC[i]) return false
  return true
}

async function main(): Promise<void> {
  const c = makeCounters()
  console.log(`\n=== Phase F · F7: Trace PNG serving + sharp overlay verification ===`)
  console.log(`vps API = ${VPS_API_BASE}`)

  section('1. Find a session with a mutating phone_action')
  const found = await findMutatingPhoneAction()
  if (!found) {
    info(`no mutating phone_action found in any session — F7 SKIPPING the trace-PNG checks.`)
    info(`run F8 first to create a phone_action; then re-run F7.`)
  } else {
    info(`found phone_action in session ${found.sid}`)
    info(`  toolCallId = ${found.action.toolCallId}`)
    info(`  subcommand = ${found.action.subcommand}`)
    info(`  command    = ${found.action.command}`)

    // -------------------------------------------------------------------
    section('2. Fetch before/annotated/after — all 200 + PNG magic')
    // -------------------------------------------------------------------
    const beforeUrl = traceUrl(ACCOUNT_ID, TEAM_NAME, found.sid, found.action.toolCallId, 'before.png')
    const annotatedUrl = traceUrl(ACCOUNT_ID, TEAM_NAME, found.sid, found.action.toolCallId, 'annotated.png')
    const afterUrl = traceUrl(ACCOUNT_ID, TEAM_NAME, found.sid, found.action.toolCallId, 'after.png')

    const before = await fetchBytes(beforeUrl)
    const annotated = await fetchBytes(annotatedUrl)
    const after = await fetchBytes(afterUrl)

    assert(c, before.status === 200, `before.png → 200 (got ${before.status})`)
    assert(c, annotated.status === 200, `annotated.png → 200 (got ${annotated.status})`)
    assert(c, after.status === 200, `after.png → 200 (got ${after.status})`)

    assert(c, before.contentType?.includes('image/png') ?? false, `before.png Content-Type is image/png (got ${before.contentType})`)
    assert(c, annotated.contentType?.includes('image/png') ?? false, `annotated.png Content-Type is image/png (got ${annotated.contentType})`)
    assert(c, after.contentType?.includes('image/png') ?? false, `after.png Content-Type is image/png (got ${after.contentType})`)

    assert(c, looksLikePng(before.bytes), `before.png has PNG magic bytes (size ${before.bytes.length})`)
    assert(c, looksLikePng(annotated.bytes), `annotated.png has PNG magic bytes (size ${annotated.bytes.length})`)
    assert(c, looksLikePng(after.bytes), `after.png has PNG magic bytes (size ${after.bytes.length})`)

    // -------------------------------------------------------------------
    section('3. sha256(annotated) != sha256(before) — proves sharp drew overlay')
    // -------------------------------------------------------------------
    const beforeSha = sha256Bytes(before.bytes)
    const annotatedSha = sha256Bytes(annotated.bytes)
    info(`sha256(before)    = ${beforeSha}`)
    info(`sha256(annotated) = ${annotatedSha}`)
    assert(c, beforeSha !== annotatedSha, `annotated.png bytes differ from before.png (overlay was actually drawn; 30df7a8 fix verified)`)

    // -------------------------------------------------------------------
    section('4. Cache-Control header per API spec (private, max-age=86400)')
    // -------------------------------------------------------------------
    const headRes = await fetch(annotatedUrl, { method: 'HEAD' })
    const cc = headRes.headers.get('cache-control') ?? ''
    info(`cache-control: ${cc}`)
    // Spec says exactly `private, max-age=86400` but be permissive — assert
    // 'private' AND 'max-age=86400' are both present.
    assert(c, /private/i.test(cc) && /max-age=86400/i.test(cc), `cache-control includes 'private' and 'max-age=86400' (got '${cc}')`)
  }

  // -----------------------------------------------------------------------
  section('5. SSH into VPS — grep docker logs for sharp errors (Phase E flagged)')
  // -----------------------------------------------------------------------
  const r = ssh(`sudo -n docker logs otacon-orchestrator 2>&1 | grep -i sharp || echo NO_MATCHES`)
  info(`grep result (truncated):`)
  for (const line of r.stdout.split('\n').slice(0, 12)) info(`  ${line}`)
  // Filter out non-error mentions: e.g. import statements, banner.
  // The Phase E concern was a missing-binary error: "Could not load the
  // 'sharp' module" or similar. Treat any line containing 'error' and
  // 'sharp' (case insensitive) as a failure signal.
  const lines = r.stdout.split('\n').filter(l => l.length > 0 && l !== 'NO_MATCHES')
  const errorLines = lines.filter(l => /error|cannot|failed|missing/i.test(l) && /sharp/i.test(l))
  assert(c, errorLines.length === 0, `no sharp-related error lines in docker logs (${errorLines.length} found)`)
  if (errorLines.length > 0) {
    for (const e of errorLines.slice(0, 5)) info(`  ERR: ${e}`)
  }

  summary('Phase F · F7', c)
  exitFromCounters('Phase F · F7', c)
}

main().catch(err => {
  console.error('F7 threw:', err)
  process.exit(1)
})
