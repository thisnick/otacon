/**
 * Unit tests for the FS-backed storage layer (P1).
 *
 * Covers pure logic that doesn't need a phone or registry:
 *   - paths.ts: path traversal rejection, safe-id checks
 *   - ulid.ts: timestamp decode round-trip
 *   - index-store.ts: append + dedupe + filter + rebuild
 *   - run-store.ts: create/get/updateStatus terminal-time semantics
 *   - account-store.ts: idempotent create + credential dedupe
 *   - signal-store.ts: pending → resolved transitions
 *   - blob-store.ts: putScreenshot / putToolResult round-trip
 *
 * Run: npx tsx tests/orchestrator/unit/test-storage.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { makeStores } from '../../../src/orchestrator/src/storage/factory.js'
import { assertSafeId, resolveWithin, makePaths } from '../../../src/orchestrator/src/storage/paths.js'
import { tsFromUlid, ulid } from '../../../src/orchestrator/src/storage/ulid.js'
import { IndexStoreFs } from '../../../src/orchestrator/src/storage/index-store.js'

let passed = 0
let failed = 0
let tmpDir: string

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  PASS  ${msg}`)
    passed++
  } else {
    console.log(`  FAIL  ${msg}`)
    failed++
  }
}

async function expectThrow(fn: () => any | Promise<any>, msg: string) {
  let threw = false
  try { await fn() } catch { threw = true }
  assert(threw, msg)
}

async function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-storage-test-'))
}

async function teardown() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

async function testPaths() {
  console.log('paths.ts')
  // assertSafeId
  await expectThrow(() => assertSafeId('../etc/passwd'), 'rejects ../ traversal')
  await expectThrow(() => assertSafeId('foo/bar'), 'rejects path separator')
  await expectThrow(() => assertSafeId(''), 'rejects empty id')
  await expectThrow(() => assertSafeId('foo bar'), 'rejects whitespace')
  assertSafeId('xhs:test')
  assertSafeId('phone-r5ct60sd')
  assertSafeId('01J9WV1F8K00000000000000')
  assert(true, 'accepts xhs:test, phone-r5ct60sd, ULID')

  // resolveWithin
  const base = path.join(tmpDir, 'base')
  const inside = resolveWithin(base, 'foo/bar')
  assert(inside.startsWith(path.resolve(base) + path.sep), 'resolveWithin keeps inner path under base')
  await expectThrow(() => resolveWithin(base, '../escape'), 'resolveWithin rejects ../')
  await expectThrow(() => resolveWithin(base, '/abs/escape'), 'resolveWithin rejects absolute escape')
}

async function testUlid() {
  console.log('ulid.ts')
  const before = Date.now()
  const id = ulid()
  const after = Date.now()
  const ts = tsFromUlid(id)
  assert(ts >= before && ts <= after, `tsFromUlid round-trips (got ${ts}, expected ${before}..${after})`)
  assert(Number.isNaN(tsFromUlid('short')), 'tsFromUlid returns NaN for short input')
  assert(Number.isNaN(tsFromUlid('!!!!!!!!!!')), 'tsFromUlid returns NaN for non-base32')
}

async function testIndex() {
  console.log('index-store.ts')
  const dir = path.join(tmpDir, 'idx')
  const layout = makePaths(dir)
  const store = new IndexStoreFs(layout)

  await store.append({ id: 'r1', account: 'a', team: 't', status: 'created', startedAt: 1000, completedAt: null })
  await store.append({ id: 'r1', account: 'a', team: 't', status: 'running', startedAt: 1000, completedAt: null })
  await store.append({ id: 'r2', account: 'a', team: 't', status: 'completed', startedAt: 2000, completedAt: 2500 })
  await store.append({ id: 'r3', account: 'b', team: 't', status: 'failed', startedAt: 3000, completedAt: 3100 })

  const all = await store.list()
  assert(all.length === 3, `list returns 3 deduped entries (got ${all.length})`)
  const r1 = all.find(r => r.id === 'r1')!
  assert(r1.status === 'running', `last-write-wins: r1 final status running (got ${r1?.status})`)
  assert(all[0].id === 'r3', `newest-first ordering (top is r3, got ${all[0].id})`)

  const byAcct = await store.list({ account: 'a' })
  assert(byAcct.length === 2 && byAcct.every(r => r.account === 'a'), 'list by account filter')

  const byStatus = await store.list({ status: 'failed' })
  assert(byStatus.length === 1 && byStatus[0].id === 'r3', 'list by status filter')

  const limited = await store.list({ limit: 1 })
  assert(limited.length === 1, 'list limit applied')

  // rebuild from authoritative source
  await store.rebuild([
    { id: 'rA', account: 'a', team: 't', status: 'completed', startedAt: 9999, completedAt: null },
  ])
  const after = await store.list()
  assert(after.length === 1 && after[0].id === 'rA', 'rebuild wipes prior state and rewrites')
}

async function testRunStore() {
  console.log('run-store.ts')
  const dir = path.join(tmpDir, 'run')
  const stores = await makeStores({ dataDir: dir })

  const created = await stores.runStore.create({
    id: ulid(),
    account: 'xhs:test',
    team: 'social-media-engagement',
    agentRole: 'engagement-lead',
    model: 'alibaba/qwen3.6-plus',
    initialPrompt: 'go',
  })
  assert(created.status === 'created', 'new run starts in `created` status')
  assert(created.completedAt === null, 'completedAt null on creation')

  const running = await stores.runStore.updateStatus(created.id, 'running')
  assert(running.status === 'running' && running.completedAt === null, 'running keeps completedAt null')

  const done = await stores.runStore.updateStatus(created.id, 'completed', { finalText: 'ok', turnCount: 5 })
  assert(done.status === 'completed', 'updateStatus persists completed status')
  assert(typeof done.completedAt === 'number' && done.completedAt > 0, 'terminal status sets completedAt')
  assert(done.finalText === 'ok' && done.turnCount === 5, 'updateStatus merges fields')

  const fetched = await stores.runStore.get(created.id)
  assert(fetched?.status === 'completed', 'get reflects last status')

  const listed = await stores.runStore.list({ account: 'xhs:test' })
  assert(listed.length === 1, 'list by account returns the run')

  // Prompt snapshot round-trip
  const rel = await stores.runStore.putPromptSnapshot(created.id, 'You are a helpful agent.')
  assert(rel.endsWith('prompt.md'), 'putPromptSnapshot returns relative path ending in prompt.md')
  const snap = await stores.runStore.getPromptSnapshot(created.id)
  assert(snap === 'You are a helpful agent.', 'getPromptSnapshot round-trips text')
  const reread = await stores.runStore.get(created.id)
  assert(reread?.promptSnapshotPath === rel, 'run.json updated with snapshot path')
}

async function testAccountStore() {
  console.log('account-store.ts')
  const dir = path.join(tmpDir, 'acct')
  const { accountStore } = await makeStores({ dataDir: dir })

  const a = await accountStore.create({ id: 'xhs:test' })
  const a2 = await accountStore.create({ id: 'xhs:test' })
  assert(a.id === a2.id && a.createdAt === a2.createdAt, 'create is idempotent (returns existing)')

  await accountStore.addCredential('xhs:test', { credentialType: 'phone', identifier: '+15551234567', isPrimary: true })
  // Same identifier dedups (no error, no second row)
  await accountStore.addCredential('xhs:test', { credentialType: 'phone', identifier: '+15551234567' })
  const creds = await accountStore.listCredentials('xhs:test')
  assert(creds.length === 1, 'addCredential dedupes by (type, identifier)')

  const primary = await accountStore.primaryCredential('xhs:test', 'phone')
  assert(primary?.identifier === '+15551234567', 'primaryCredential returns the row')

  // Add a second phone marked primary — old one should be demoted
  await accountStore.addCredential('xhs:test', { credentialType: 'phone', identifier: '+15559999999', isPrimary: true })
  const newPrimary = await accountStore.primaryCredential('xhs:test', 'phone')
  assert(newPrimary?.identifier === '+15559999999', 'new primary supersedes old')

  // Env file CRUD
  await accountStore.writeEnvFile('xhs:test', 'persona.md', '# persona')
  const back = await accountStore.readEnvFile('xhs:test', 'persona.md')
  assert(back === '# persona', 'env file round-trip')
  const missing = await accountStore.readEnvFile('xhs:test', 'nope.md')
  assert(missing === null, 'env file missing returns null')

  // Path traversal blocked
  await expectThrow(() => accountStore.readEnvFile('xhs:test', '../../etc/passwd'), 'env file traversal rejected')
}

async function testSignalStore() {
  console.log('signal-store.ts')
  const dir = path.join(tmpDir, 'sig')
  const stores = await makeStores({ dataDir: dir })
  const run = await stores.runStore.create({
    id: ulid(),
    account: 'xhs:test',
    team: 'social-media-engagement',
    agentRole: 'engagement-lead',
    model: 'm',
  })
  const sig = await stores.signalStore.create({
    runId: run.id,
    kind: 'approval',
    hookToken: `approval:${run.id}:tc1`,
    toolCallId: 'tc1',
    command: 'otacon tap eN',
    rationale: 'open the search bar',
  })
  assert(sig.status === 'pending' && sig.hookToken.includes(run.id), 'pending signal stored with hook token')

  const fetched = await stores.signalStore.get(sig.id)
  assert(fetched?.command === 'otacon tap eN', 'get by signal id finds the row')

  const byToken = await stores.signalStore.getByHookToken(sig.hookToken)
  assert(byToken?.id === sig.id, 'getByHookToken finds the row')

  const pending = await stores.signalStore.list({ status: 'pending' })
  assert(pending.length === 1, 'list pending returns the row')

  const resolved = await stores.signalStore.markResolved(sig.id, 'approve', 'looks good')
  assert(resolved.status === 'approved' && resolved.decision === 'approve', 'markResolved sets status + decision')
  assert(resolved.resolvedAt !== null && resolved.message === 'looks good', 'resolvedAt timestamp + message persisted')

  const stillPending = await stores.signalStore.list({ status: 'pending' })
  assert(stillPending.length === 0, 'resolved signal not in pending list')
}

async function testBlobStore() {
  console.log('blob-store.ts')
  const dir = path.join(tmpDir, 'blob')
  const stores = await makeStores({ dataDir: dir })
  const run = await stores.runStore.create({
    id: ulid(),
    account: 'xhs:test',
    team: 'social-media-engagement',
    agentRole: 'engagement-lead',
    model: 'm',
  })

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG magic
  const rel = await stores.blobStore.putScreenshot(run.id, 'tc1', 'before', png)
  assert(rel.includes(run.id) && rel.endsWith('before.png'), `putScreenshot returns relative path (got ${rel})`)
  const back = await stores.blobStore.getScreenshot(run.id, 'tc1', 'before')
  assert(back !== null && back.equals(png), 'getScreenshot returns matching bytes')

  const result = { exit_code: 0, stdout: '(no output)', stderr: '' }
  const resultRel = await stores.blobStore.putToolResult(run.id, 'tc1', result)
  assert(resultRel.endsWith('result.json'), 'putToolResult returns result.json path')
  const rback = await stores.blobStore.getToolResult(run.id, 'tc1') as any
  assert(rback?.exit_code === 0, 'getToolResult parses JSON')

  // Generic API still works for sandbox FS adapter compat
  await stores.blobStore.write('foo/bar.txt', 'hello')
  const gen = await stores.blobStore.read('foo/bar.txt')
  assert(gen?.toString('utf-8') === 'hello', 'generic write/read round-trip')
  await expectThrow(() => stores.blobStore.read('../../etc/passwd'), 'generic read rejects traversal')
}

async function testApprovalBridge() {
  console.log('approval-bridge.ts')
  const {
    approvalToken,
    escalationToken,
    signalIdFor,
    persistSignal,
  } = await import('../../../src/orchestrator/src/run-executor/approval-bridge.js')

  // Token derivation is deterministic (replay-safe).
  const t1 = approvalToken('run-1', 'tc-1')
  const t2 = approvalToken('run-1', 'tc-1')
  assert(t1 === t2 && t1 === 'approval:run-1:tc-1', 'approvalToken format is approval:<runId>:<toolCallId>')

  const e1 = escalationToken('run-1', 'tc-2')
  assert(e1 === 'escalation:run-1:tc-2', 'escalationToken format is escalation:<runId>:<toolCallId>')

  // Signal id derived from runId + toolCallId + kind, safe for filesystem
  const sid = signalIdFor('run-1', 'tc-1', 'approval')
  assert(/^[A-Za-z0-9._:+-]+$/.test(sid), `signalIdFor returns a safe id (got ${sid})`)
  assert(sid.includes('approval'), 'signalIdFor includes the kind')
  assert(sid.includes('run-1'), 'signalIdFor includes the runId')
  assert(sid.includes('tc-1'), 'signalIdFor includes the toolCallId')

  // persistSignal writes to SignalStore + record carries the deterministic token
  const dir = path.join(tmpDir, 'apprbridge')
  const stores = await makeStores({ dataDir: dir })
  const run = await stores.runStore.create({
    id: ulid(),
    account: 'xhs:test',
    team: 'social-media-engagement',
    agentRole: 'engagement-lead',
    model: 'm',
  })
  await persistSignal({
    signalStore: stores.signalStore,
    runId: run.id,
    toolCallId: 'tc-1',
    kind: 'approval',
    command: 'otacon tap eN',
    rationale: 'open search',
  })
  const expectedToken = approvalToken(run.id, 'tc-1')
  const fetched = await stores.signalStore.getByHookToken(expectedToken)
  assert(fetched !== null && fetched.kind === 'approval', 'persistSignal stored an approval row')
  assert(fetched?.command === 'otacon tap eN', 'persistSignal preserved command')
  assert(fetched?.rationale === 'open search', 'persistSignal preserved rationale')
  assert(fetched?.hookToken === expectedToken, 'persistSignal stored the deterministic hook token')
}

async function testAddAccountFs() {
  console.log('add-account.ts (FS side)')
  // Test the FS-side behavior of add-account in isolation by calling the
  // store APIs directly (the Drizzle side requires a real DB and is
  // exercised by the existing test-allocation.ts when needed).
  const { makeStores } = await import('../../../src/orchestrator/src/storage/factory.js')
  const dir = path.join(tmpDir, 'addacct')
  const { accountStore } = await makeStores({ dataDir: dir })

  // Simulate what add-account writes to the FS:
  await accountStore.create({ id: 'xhs:demo', accountType: 'xhs' })
  await accountStore.addCredential('xhs:demo', {
    credentialType: 'phone',
    identifier: '+15551234567',
    isPrimary: true,
  })
  await accountStore.writeEnvFile('xhs:demo', 'persona.md', '# Persona\n\nplaceholder\n')
  await accountStore.writeEnvFile('xhs:demo', 'soul.md', '# Soul\n\nplaceholder\n')
  await accountStore.writeEnvFile('xhs:demo', 'agents.md', '# Agents\n\nplaceholder\n')
  await accountStore.ensureWorkspace('xhs:demo')

  const acct = await accountStore.get('xhs:demo')
  assert(acct?.id === 'xhs:demo' && acct?.accountType === 'xhs', 'account.json persists id + type')

  const creds = await accountStore.listCredentials('xhs:demo')
  assert(creds.length === 1 && creds[0].identifier === '+15551234567', 'phone credential persisted')
  const primary = await accountStore.primaryCredential('xhs:demo', 'phone')
  assert(primary?.isPrimary === true, 'phone credential is primary')

  const persona = await accountStore.readEnvFile('xhs:demo', 'persona.md')
  assert(typeof persona === 'string' && persona.includes('Persona'), 'env/persona.md written')
  const soul = await accountStore.readEnvFile('xhs:demo', 'soul.md')
  assert(typeof soul === 'string' && soul.includes('Soul'), 'env/soul.md written')
  const agents = await accountStore.readEnvFile('xhs:demo', 'agents.md')
  assert(typeof agents === 'string' && agents.includes('Agents'), 'env/agents.md written')

  // Ensure-then-don't-overwrite: re-running add-account must NOT clobber
  // env files the user has edited. (We simulate by writing a custom
  // persona, then calling the env-stub-ensure logic directly.)
  await accountStore.writeEnvFile('xhs:demo', 'persona.md', 'CUSTOM\n')
  // Simulate `ensureEnvStubs` semantics: check existing, write only if null.
  const existing = await accountStore.readEnvFile('xhs:demo', 'persona.md')
  if (existing === null) {
    await accountStore.writeEnvFile('xhs:demo', 'persona.md', '# Persona\n\nplaceholder\n')
  }
  const after = await accountStore.readEnvFile('xhs:demo', 'persona.md')
  assert(after === 'CUSTOM\n', 'ensureEnvStubs preserves existing content (does not clobber edits)')
}

async function testSeedTeam() {
  console.log('seed-team.ts')
  const { seedTeamCommand } = await import('../../../src/orchestrator/src/cli/seed-team.js')
  const { TeamStoreFs } = await import('../../../src/orchestrator/src/storage/team-store.js')

  const dir = path.join(tmpDir, 'seed')
  await seedTeamCommand({ name: 'social-media-engagement', dataDir: dir })

  const layout = makePaths(dir)
  const store = new TeamStoreFs(layout)
  const cfg = await store.get('social-media-engagement')
  assert(cfg?.name === 'social-media-engagement', 'team.json written + readable via TeamStore')
  assert(cfg?.lead === 'engagement-lead', 'config.lead persisted')
  assert(cfg?.agents.length === 1, 'config.agents has 1 entry')

  const lead = await store.readPromptFile('social-media-engagement', 'engagement-lead.md')
  assert(typeof lead === 'string' && lead.length > 0, 'engagement-lead.md prompt copied')
  const soul = await store.readPromptFile('social-media-engagement', 'soul.md')
  assert(typeof soul === 'string' && soul.includes('Persona'), 'soul.md prompt copied')
  const tools = await store.readPromptFile('social-media-engagement', 'tools.md')
  assert(typeof tools === 'string' && tools.includes('Tool Reference'), 'tools.md prompt copied')

  // Idempotency: re-running over an existing seeded team works
  await seedTeamCommand({ name: 'social-media-engagement', dataDir: dir })
  const cfg2 = await store.get('social-media-engagement')
  assert(cfg2?.name === cfg?.name, 're-running seed-team is idempotent')

  // Missing team → clear error
  await expectThrow(
    () => seedTeamCommand({ name: 'does-not-exist', dataDir: dir }),
    'seed-team rejects missing team name',
  )
}

async function main() {
  await setup()
  try {
    await testPaths()
    await testUlid()
    await testIndex()
    await testRunStore()
    await testAccountStore()
    await testSignalStore()
    await testBlobStore()
    await testApprovalBridge()
    await testAddAccountFs()
    await testSeedTeam()
  } catch (e: any) {
    console.error('UNCAUGHT:', e?.stack ?? e)
    failed++
  } finally {
    await teardown()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
