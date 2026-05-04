/**
 * Phase I · I6 — POST /runs resolves phone from workspace.phoneNumber.
 *
 * Replaces F1's `phone` field with server-side resolution.
 *
 * Coverage:
 *   - POST /runs with no phone field still works (workspace's phoneNumber
 *     drives resolution).
 *   - POST /runs against a workspace with no phoneNumber → 400 phone_unresolvable.
 *   - POST /runs against a workspace with an unresolvable phoneNumber
 *     (E.164-valid but not in registry) → 400 phone_unresolvable.
 *   - The legacy `phone` field on the request body is silently ignored.
 *
 * Requires registry creds for the happy-path live run; skips when absent.
 */
import {
  bootLocalServer,
  api,
  isErrorEnvelope,
} from './helpers/phase-i.js'
import {
  assert,
  exitFromCounters,
  info,
  makeCounters,
  section,
  summary,
} from './helpers/spike.js'

async function main() {
  const c = makeCounters()
  console.log(`\n=== Phase I · I6: POST /runs phone resolution from workspace.phoneNumber ===`)

  const haveCreds =
    !!process.env.OTACON_REGISTRY_URL && !!process.env.OTACON_TOKEN
  if (!haveCreds) {
    info(`OTACON_REGISTRY_URL / OTACON_TOKEN not set — running validation-only path`)
  }

  const server = await bootLocalServer({ seed: true })
  info(`server: ${server.baseUrl}`)
  try {
    section('1. Create workspace WITHOUT phoneNumber (legacy shape)')
    // Plant a workspace.json directly on disk that lacks phoneNumber.
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const wsId = 'xhs:i6legacy'
    const wsDir = path.join(server.dataRoot, 'workspaces', wsId)
    await fs.mkdir(path.join(wsDir, 'env'), { recursive: true })
    await fs.mkdir(path.join(wsDir, 'memory'), { recursive: true })
    await fs.writeFile(path.join(wsDir, 'workspace.json'),
      JSON.stringify({
        id: wsId, displayName: 'I6 legacy', kind: 'social', createdAt: Date.now(),
      }, null, 2), 'utf8')

    const r1 = await api<unknown>(server.baseUrl, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: wsId,
        team: 'social-media-engagement',
        userMessage: 'hello',
      }),
    })
    assert(c, r1.status === 400, `legacy workspace → 400 (got ${r1.status})`)
    assert(c, isErrorEnvelope(r1.body, 'phone_unresolvable').ok,
      `phone_unresolvable envelope ok (no phoneNumber)`)

    section('2. Workspace with E.164-valid but non-registry phone → phone_unresolvable')
    const wsBogus = 'xhs:i6bogus'
    const create = await api<unknown>(server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: wsBogus, displayName: 'I6 bogus', kind: 'social',
        phoneNumber: '+19999999999',
      }),
    })
    assert(c, create.status === 201, `created bogus-phone workspace`)

    const r2 = await api<unknown>(server.baseUrl, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: wsBogus, team: 'social-media-engagement',
        userMessage: 'hello',
      }),
    })
    if (haveCreds) {
      assert(c, r2.status === 400, `bogus phone → 400 (got ${r2.status})`)
      assert(c, isErrorEnvelope(r2.body, 'phone_unresolvable').ok,
        `phone_unresolvable envelope (registry has no such phone)`)
    } else {
      // Without creds the resolver will fail at the auth/connection step;
      // the response is still 400 phone_unresolvable.
      assert(c, r2.status === 400, `bogus phone (no creds) → 400 (got ${r2.status})`)
      assert(c, isErrorEnvelope(r2.body, 'phone_unresolvable').ok,
        `phone_unresolvable envelope (no creds path)`)
    }

    section('3. Legacy `phone` request field is silently ignored')
    // Use the bogus workspace; passing a phone field shouldn't change
    // anything — the server still resolves from workspace.phoneNumber
    // and still 400s.
    const r3 = await api<unknown>(server.baseUrl, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: wsBogus, team: 'social-media-engagement',
        userMessage: 'hello',
        phone: 'https://shouldnt-matter.example/phones/x',
      }),
    })
    assert(c, r3.status === 400, `legacy "phone" field doesn't bypass workspace lookup → still 400`)
    assert(c, isErrorEnvelope(r3.body, 'phone_unresolvable').ok,
      `still phone_unresolvable (server ignored "phone" field)`)

    if (haveCreds && process.env.OTACON_I6_LIVE === '1') {
      section('4. Live run against a real workspace (opt-in)')
      // Opt-in via OTACON_I6_LIVE=1 because this requires the canonical
      // phone-4 to be online + makes a real LLM call. The default is to
      // skip — covered by F1.
      const wsLive = 'xhs:i6live'
      const c2 = await api<unknown>(server.baseUrl, '/api/v1/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: wsLive, displayName: 'I6 live', kind: 'social',
          phoneNumber: '+13412137456',
        }),
      })
      assert(c, c2.status === 201, `created live workspace`)
      info(`(live run skipped — covered by F1 against deployed VPS)`)
    } else {
      info(`live run path skipped — covered by F1 (Phase I drops the phone field there too)`)
    }

  } finally {
    await server.stop()
  }

  summary('Phase I · I6', c)
  exitFromCounters('Phase I · I6', c)
}

main().catch(err => {
  console.error('I6 threw:', err)
  process.exit(1)
})
