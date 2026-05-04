/**
 * Phase I · I2 — Env files CRUD.
 *
 * Coverage:
 *   - GET /env on a fresh workspace → seeded persona/soul/memory entries
 *   - GET /env/:file returns text/markdown
 *   - PUT /env/:file overwrites; subsequent GET returns the new content
 *   - DELETE /env/:file
 *   - POST /env/:file/reset reverts to seed default
 *   - POST /env/:file/reset on a non-default file → 404 no_default_for_file
 *   - Invalid filenames rejected (path traversal, non-.md, dotfile)
 *   - One-shot agents.md → memory.md migration
 */
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import {
  bootLocalServer,
  api,
  apiText,
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

interface EnvFileSummary {
  name: string
  size: number
  modifiedAt: number
}

async function main() {
  const c = makeCounters()
  console.log(`\n=== Phase I · I2: env files CRUD ===`)

  const server = await bootLocalServer({ seed: false })
  info(`server: ${server.baseUrl}`)
  try {
    section('1. Create workspace, expect default env files')
    const create = await api<unknown>(server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'xhs:i2', displayName: 'I2', kind: 'social', phoneNumber: '+13412137456',
      }),
    })
    assert(c, create.status === 201, `created xhs:i2 (got ${create.status})`)

    const list = await api<EnvFileSummary[]>(server.baseUrl, '/api/v1/workspaces/xhs%3Ai2/env')
    assert(c, list.status === 200, `GET env → 200`)
    const names = (list.body as EnvFileSummary[]).map(f => f.name).sort()
    assert(c, names.includes('persona.md'), `persona.md seeded`)
    assert(c, names.includes('soul.md'), `soul.md seeded`)
    assert(c, names.includes('memory.md'), `memory.md seeded`)
    assert(c, JSON.stringify(names) === JSON.stringify(['memory.md', 'persona.md', 'soul.md']),
      `list sorted alphabetically (got ${JSON.stringify(names)})`)
    for (const f of list.body as EnvFileSummary[]) {
      assert(c, typeof f.size === 'number' && f.size > 0, `${f.name} size > 0`)
      assert(c, typeof f.modifiedAt === 'number' && f.modifiedAt > 0, `${f.name} modifiedAt > 0`)
    }

    section('2. GET single env file (text/markdown)')
    const persona = await apiText(server.baseUrl, '/api/v1/workspaces/xhs%3Ai2/env/persona.md')
    assert(c, persona.status === 200, `GET persona.md → 200`)
    assert(c, persona.contentType?.includes('text/markdown') === true,
      `content-type is text/markdown (got ${persona.contentType})`)
    assert(c, persona.raw.includes('Persona'), `body has expected content`)

    section('3. PUT overwrites; reset reverts')
    const put1 = await apiText(server.baseUrl, '/api/v1/workspaces/xhs%3Ai2/env/persona.md', {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown' },
      body: '## CUSTOM PERSONA\n',
    })
    assert(c, put1.status === 204, `PUT → 204 (got ${put1.status})`)
    const after = await apiText(server.baseUrl, '/api/v1/workspaces/xhs%3Ai2/env/persona.md')
    assert(c, after.raw === '## CUSTOM PERSONA\n', `GET after PUT returns new body`)

    const reset = await apiText(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai2/env/persona.md/reset', { method: 'POST' })
    assert(c, reset.status === 200, `reset → 200`)
    assert(c, reset.raw.includes('Persona'), `reset body restores default`)
    const afterReset = await apiText(server.baseUrl, '/api/v1/workspaces/xhs%3Ai2/env/persona.md')
    assert(c, afterReset.raw === reset.raw, `disk content matches reset return`)

    section('4. DELETE env file')
    const del = await apiText(server.baseUrl, '/api/v1/workspaces/xhs%3Ai2/env/soul.md', { method: 'DELETE' })
    assert(c, del.status === 204, `DELETE → 204`)
    const get404 = await api<unknown>(server.baseUrl, '/api/v1/workspaces/xhs%3Ai2/env/soul.md')
    assert(c, get404.status === 404, `GET deleted → 404`)
    assert(c, isErrorEnvelope(get404.body, 'env_file_not_found').ok,
      `env_file_not_found envelope ok`)

    section('5. Reset non-default env file → 404 no_default_for_file')
    const putCustom = await apiText(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai2/env/custom.md', {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown' },
      body: 'user-added\n',
    })
    assert(c, putCustom.status === 204, `created custom.md`)
    const noDef = await api<unknown>(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai2/env/custom.md/reset', { method: 'POST' })
    assert(c, noDef.status === 404, `reset custom file → 404 (got ${noDef.status})`)
    assert(c, isErrorEnvelope(noDef.body, 'no_default_for_file').ok,
      `no_default_for_file envelope ok`)

    section('6. Filename validation (path traversal, dotfile, non-.md)')
    const badNames: Array<[string, string]> = [
      ['..%2Ftraversal.md', 'traversal'],
      ['.hidden.md', 'dotfile'],
      ['file.txt', 'non-.md'],
    ]
    for (const [name, label] of badNames) {
      const r = await api<unknown>(server.baseUrl, `/api/v1/workspaces/xhs%3Ai2/env/${name}`)
      assert(c, r.status === 400 || r.status === 404,
        `bad name (${label}) rejected (got ${r.status})`)
    }

    section('7. agents.md → memory.md one-shot migration')
    // Create another workspace, manually plant agents.md, then ensure
    // listing migrates it to memory.md.
    const w3 = await api<unknown>(server.baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'xhs:i2legacy', displayName: 'legacy', kind: 'social', phoneNumber: '+13412137456',
      }),
    })
    assert(c, w3.status === 201, `created legacy workspace`)
    // Server seeded memory.md by default; remove it + plant agents.md.
    const envDir = path.join(server.dataRoot, 'workspaces', 'xhs:i2legacy', 'env')
    await fs.unlink(path.join(envDir, 'memory.md'))
    await fs.writeFile(path.join(envDir, 'agents.md'), '## legacy agents content\n', 'utf8')

    const listLegacy = await api<EnvFileSummary[]>(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai2legacy/env')
    assert(c, listLegacy.status === 200, `legacy list → 200`)
    const legacyNames = (listLegacy.body as EnvFileSummary[]).map(f => f.name)
    assert(c, legacyNames.includes('memory.md'),
      `agents.md migrated to memory.md (got ${JSON.stringify(legacyNames)})`)
    assert(c, !legacyNames.includes('agents.md'), `agents.md no longer present after migration`)

    const migratedContent = await apiText(server.baseUrl,
      '/api/v1/workspaces/xhs%3Ai2legacy/env/memory.md')
    assert(c, migratedContent.raw === '## legacy agents content\n',
      `migrated content preserved`)

  } finally {
    await server.stop()
  }

  summary('Phase I · I2', c)
  exitFromCounters('Phase I · I2', c)
}

main().catch(err => {
  console.error('I2 threw:', err)
  process.exit(1)
})
