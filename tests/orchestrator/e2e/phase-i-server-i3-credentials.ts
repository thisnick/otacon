/**
 * Phase I · I3 — Credentials write-only.
 *
 * Coverage:
 *   - GET /credentials on a fresh workspace → {hasCredentials: false}
 *   - PUT JSON body → 204
 *   - GET after PUT → {hasCredentials: true, fieldsSet: [...]} but NEVER values
 *   - DELETE → 204
 *   - GET after DELETE → {hasCredentials: false}
 *   - PUT non-object body → 400 bad_request
 *   - Disk file matches PUT body verbatim (so the agent can read it)
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
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

interface CredentialsStatus {
  hasCredentials: boolean
  fieldsSet: string[]
}

async function main() {
  const c = makeCounters()
  console.log(`\n=== Phase I · I3: credentials write-only ===`)

  const server = await bootLocalServer({ seed: false })
  info(`server: ${server.baseUrl}`)
  try {
    section('1. Setup workspace')
    const create = await api<unknown>(server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'xhs:i3', displayName: 'I3', kind: 'social', phoneNumber: '+13412137456',
      }),
    })
    assert(c, create.status === 201, `created xhs:i3`)

    section('2. GET on fresh workspace → hasCredentials false')
    const empty = await api<CredentialsStatus>(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai3/credentials')
    assert(c, empty.status === 200, `GET empty → 200`)
    assert(c, empty.body.hasCredentials === false, `hasCredentials=false initially`)
    assert(c, Array.isArray(empty.body.fieldsSet) && empty.body.fieldsSet.length === 0,
      `fieldsSet empty initially`)

    section('3. PUT credentials, then GET → status reports fields without values')
    const secret = { cookies: 'session=ABCD', deviceId: 'X-1', ua: 'Mozilla/5.0' }
    const put = await api<unknown>(server.baseUrl, '/api/v1/workspaces/xhs%3Ai3/credentials', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(secret),
    })
    assert(c, put.status === 204, `PUT → 204 (got ${put.status})`)

    const after = await api<CredentialsStatus>(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai3/credentials')
    assert(c, after.status === 200, `GET after PUT → 200`)
    assert(c, after.body.hasCredentials === true, `hasCredentials=true`)
    assert(c, JSON.stringify(after.body.fieldsSet.sort()) ===
      JSON.stringify(['cookies', 'deviceId', 'ua']),
      `fieldsSet keys reported (got ${JSON.stringify(after.body.fieldsSet)})`)
    // Critical: the response MUST NOT contain any of the secret values.
    const rawText = JSON.stringify(after.body)
    assert(c, !rawText.includes('session=ABCD'),
      `response does not leak "cookies" value`)
    assert(c, !rawText.includes('Mozilla/5.0'),
      `response does not leak "ua" value`)
    assert(c, !rawText.includes('X-1'),
      `response does not leak "deviceId" value`)

    section('4. Disk file is the agent-readable JSON we PUT')
    const credsPath = path.join(server.dataRoot, 'workspaces', 'xhs:i3', 'credentials.json')
    const onDisk = await fs.readFile(credsPath, 'utf8')
    const parsed = JSON.parse(onDisk) as Record<string, string>
    assert(c, parsed.cookies === 'session=ABCD', `disk file has cookies value`)
    assert(c, parsed.deviceId === 'X-1', `disk file has deviceId value`)
    assert(c, parsed.ua === 'Mozilla/5.0', `disk file has ua value`)

    section('5. PUT non-object body → 400')
    const arrPut = await api<unknown>(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai3/credentials', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(['not', 'an', 'object']),
    })
    assert(c, arrPut.status === 400, `PUT array → 400 (got ${arrPut.status})`)
    assert(c, isErrorEnvelope(arrPut.body, 'bad_request').ok, `bad_request envelope ok`)

    const scalarPut = await api<unknown>(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai3/credentials', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify('hello'),
    })
    assert(c, scalarPut.status === 400, `PUT string → 400 (got ${scalarPut.status})`)

    section('6. DELETE → 204; GET → hasCredentials false again')
    const del = await api<unknown>(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai3/credentials', { method: 'DELETE' })
    assert(c, del.status === 204, `DELETE → 204`)
    const empty2 = await api<CredentialsStatus>(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai3/credentials')
    assert(c, empty2.body.hasCredentials === false, `cleared`)

    section('7. Credentials never returned via list/get of workspace itself')
    const wsGet = await api<Record<string, unknown>>(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai3')
    assert(c, !('credentials' in wsGet.body), `workspace GET has no credentials field`)

  } finally {
    await server.stop()
  }

  summary('Phase I · I3', c)
  exitFromCounters('Phase I · I3', c)
}

main().catch(err => {
  console.error('I3 threw:', err)
  process.exit(1)
})
