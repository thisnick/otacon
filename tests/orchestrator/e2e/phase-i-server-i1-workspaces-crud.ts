/**
 * Phase I · I1 — Workspaces CRUD against a local orchestrator server.
 *
 * Coverage:
 *   - POST /workspaces happy path + 201 + Workspace body
 *   - POST validation: missing fields, bad id pattern, bad E.164
 *   - POST duplicate id → 409 workspace_already_exists
 *   - GET /workspaces (list) and GET /workspaces/:id (single, 404)
 *   - PATCH partial update + immutability of id/createdAt
 *   - DELETE without ?force=true on a clean workspace → 204
 *   - DELETE with ?force=true (cascade)
 *
 * The helper boots a fresh server with an empty data root per scenario so
 * tests are hermetic.
 *
 * Run: `pnpm --filter orchestrator build && tsx tests/orchestrator/e2e/phase-i-server-i1-workspaces-crud.ts`
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

interface Workspace {
  id: string
  displayName: string
  kind: string
  phoneNumber?: string
  externalRef?: string
  createdAt: number
}

async function main() {
  const c = makeCounters()
  console.log(`\n=== Phase I · I1: workspaces CRUD ===`)

  const server = await bootLocalServer({ seed: false })
  info(`server: ${server.baseUrl} (data ${server.dataRoot})`)
  try {
    section('1. List empty')
    const empty = await api<Workspace[]>(server.baseUrl, '/api/v1/workspaces')
    assert(c, empty.status === 200, `GET /workspaces → 200 (got ${empty.status})`)
    assert(c, Array.isArray(empty.body) && empty.body.length === 0,
      `empty list initially (got ${JSON.stringify(empty.body)})`)

    section('2. POST validation errors')

    const noId = await api<unknown>(server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'x', kind: 'social', phoneNumber: '+13412137456' }),
    })
    assert(c, noId.status === 400, `POST missing id → 400 (got ${noId.status})`)
    assert(c, isErrorEnvelope(noId.body, 'bad_request').ok, `missing-id envelope ok`)

    const badId = await api<unknown>(server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'no-colon', displayName: 'x', kind: 'social', phoneNumber: '+13412137456' }),
    })
    assert(c, badId.status === 400, `POST bad-id-format → 400 (got ${badId.status})`)

    const badPhone = await api<unknown>(server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'xhs:i1', displayName: 'x', kind: 'social', phoneNumber: 'not-e164' }),
    })
    assert(c, badPhone.status === 400, `POST bad E.164 → 400 (got ${badPhone.status})`)
    assert(c, isErrorEnvelope(badPhone.body, 'bad_request').ok, `bad-phone envelope ok`)

    section('3. POST happy path + 201 + side effects')

    const create = await api<Workspace>(server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'xhs:i1',
        displayName: 'I1 test',
        kind: 'social',
        phoneNumber: '+13412137456',
        externalRef: 'xhs:i1ref',
      }),
    })
    assert(c, create.status === 201, `POST happy → 201 (got ${create.status})`)
    const ws = create.body
    assert(c, ws.id === 'xhs:i1', `body.id = "xhs:i1" (got ${ws.id})`)
    assert(c, ws.displayName === 'I1 test', `body.displayName = "I1 test"`)
    assert(c, ws.kind === 'social', `body.kind = "social"`)
    assert(c, ws.phoneNumber === '+13412137456', `body.phoneNumber populated`)
    assert(c, ws.externalRef === 'xhs:i1ref', `body.externalRef populated`)
    assert(c, typeof ws.createdAt === 'number' && ws.createdAt > 0, `createdAt set by server`)

    section('4. POST duplicate → 409 workspace_already_exists')

    const dup = await api<unknown>(server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'xhs:i1', displayName: 'x', kind: 'social', phoneNumber: '+13412137456',
      }),
    })
    assert(c, dup.status === 409, `dup POST → 409 (got ${dup.status})`)
    assert(c, isErrorEnvelope(dup.body, 'workspace_already_exists').ok,
      `workspace_already_exists envelope ok`)

    section('5. GET single + GET list')

    const get = await api<Workspace>(server.baseUrl, '/api/v1/workspaces/xhs%3Ai1')
    assert(c, get.status === 200, `GET single → 200`)
    assert(c, get.body.id === 'xhs:i1', `single body matches`)

    const get404 = await api<unknown>(server.baseUrl, '/api/v1/workspaces/xhs%3Anope')
    assert(c, get404.status === 404, `GET missing → 404`)
    assert(c, isErrorEnvelope(get404.body, 'workspace_not_found').ok,
      `workspace_not_found envelope ok`)

    const list = await api<Workspace[]>(server.baseUrl, '/api/v1/workspaces')
    assert(c, list.status === 200 && Array.isArray(list.body), `list 200 + array`)
    assert(c, list.body.some(w => w.id === 'xhs:i1'), `list contains xhs:i1`)

    section('6. PATCH — partial update + immutability')

    const createdAt = ws.createdAt
    const patch = await api<Workspace>(server.baseUrl, '/api/v1/workspaces/xhs%3Ai1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'I1 renamed', externalRef: '' }),
    })
    assert(c, patch.status === 200, `PATCH → 200 (got ${patch.status})`)
    assert(c, patch.body.displayName === 'I1 renamed', `displayName updated`)
    assert(c, patch.body.externalRef === undefined, `externalRef cleared by empty string`)
    assert(c, patch.body.id === 'xhs:i1', `id immutable`)
    assert(c, patch.body.createdAt === createdAt, `createdAt unchanged`)

    const patchBadPhone = await api<unknown>(server.baseUrl, '/api/v1/workspaces/xhs%3Ai1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: 'bad' }),
    })
    assert(c, patchBadPhone.status === 400, `PATCH bad phone → 400`)

    section('7. DELETE without force, then with force')

    const del = await api<unknown>(server.baseUrl, '/api/v1/workspaces/xhs%3Ai1', { method: 'DELETE' })
    assert(c, del.status === 204, `DELETE clean workspace → 204 (got ${del.status})`)

    const get404after = await api<unknown>(server.baseUrl, '/api/v1/workspaces/xhs%3Ai1')
    assert(c, get404after.status === 404, `GET after delete → 404`)

    section('8. workspace_has_sessions guard (non-force)')

    // Create another workspace and stamp a session dir on disk, then try
    // to delete without ?force=true. Verify 409.
    const w2 = await api<Workspace>(server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'xhs:i1b', displayName: 'I1b', kind: 'social', phoneNumber: '+13412137456' }),
    })
    assert(c, w2.status === 201, `created xhs:i1b for session-guard test`)
    // Forge a session dir.
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const sessDir = path.join(server.dataRoot, 'workspaces', 'xhs:i1b', 'teams', 'social-media-engagement', 'sessions', '01HZSESSION0000000000000000')
    await fs.mkdir(sessDir, { recursive: true })

    const delGuard = await api<unknown>(server.baseUrl, '/api/v1/workspaces/xhs%3Ai1b', { method: 'DELETE' })
    assert(c, delGuard.status === 409, `DELETE w/ sessions, no force → 409 (got ${delGuard.status})`)
    assert(c, isErrorEnvelope(delGuard.body, 'workspace_has_sessions').ok,
      `workspace_has_sessions envelope ok`)

    const delForce = await api<unknown>(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai1b?force=true', { method: 'DELETE' })
    assert(c, delForce.status === 204, `DELETE with force → 204 (got ${delForce.status})`)

  } finally {
    await server.stop()
  }

  summary('Phase I · I1', c)
  exitFromCounters('Phase I · I1', c)
}

main().catch(err => {
  console.error('I1 threw:', err)
  process.exit(1)
})
