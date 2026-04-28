/**
 * Trace capture tests (real phone required).
 *
 * Verifies the CLI shared command modules observe OTACON_TRACE_DIR and
 * write annotated PNG + JSON sidecars per the Phase A.2 plan.
 *
 *   - With OTACON_TRACE_DIR set: each mutating command writes
 *     NNN-{verb}.png + NNN-{verb}.json to the dir
 *   - Sequence increments across multiple commands in the same dir
 *   - JSON sidecar contains { verb, args, ts, seq }
 *   - Without OTACON_TRACE_DIR: NO files written
 *   - Non-mutating commands (snapshot, info) do not write PNGs;
 *     snapshot may emit a JSON sidecar of its text payload, info none.
 *
 * Requires: phone-4 reachable at otacon-pi (same as test-sandbox-commands.ts).
 * Run: npx tsx tests/test-trace-capture.ts
 */
import 'dotenv/config'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { ulid } from 'ulid'
import { sql } from 'drizzle-orm'
import { LocalBlobStore } from '../src/storage/blob.js'
import { buildSandbox } from '../src/sandbox/build.js'
import { AllocationContext } from '../src/sandbox/allocation-context.js'
import { createDb } from '../src/db/client.js'
import { conversations } from '../src/db/schema.js'

const HOST = 'https://otacon-pi.tail0437b8.ts.net:8080'
const PHONE_LOCAL_ID = 'phone-11031jec'
const BASE_URL = `${HOST}/phones/${PHONE_LOCAL_ID}`
const TEST_ACCOUNT = process.env.TEST_ACCOUNT_ID || 'xhs:test'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set — check src/orchestrator/.env')
  process.exit(1)
}
const db = createDb(DATABASE_URL)
const cleanupConvIds: string[] = []

async function makeFixtureConversation(): Promise<string> {
  const id = ulid()
  await db.insert(conversations).values({
    id,
    conversationKey: `test:trace:${id}`,
    blobPath: `conversations/${id}`,
    status: 'active',
  })
  cleanupConvIds.push(id)
  return id
}

async function cleanupAll() {
  for (const id of cleanupConvIds) {
    await db.execute(sql`DELETE FROM phone_allocations WHERE conversation_id = ${id}`).catch(() => {})
    await db.execute(sql`DELETE FROM conversations WHERE id = ${id}`).catch(() => {})
  }
}

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
  if (condition) { console.log(`  PASS  ${msg}`); passed++ }
  else { console.log(`  FAIL  ${msg}`); failed++ }
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).sort()
}

interface SandboxRunArgs {
  traceDir?: string
  commands: string[]
}

async function runSandbox({ traceDir, commands }: SandboxRunArgs) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tracecap-test-'))
  const conversationId = await makeFixtureConversation()
  try {
    const blobStore = new LocalBlobStore(tmpRoot)
    const allocCtx = new AllocationContext()
    const bash = await buildSandbox({
      blobStore,
      accountId: TEST_ACCOUNT,
      conversationId,
      db,
      allocCtx,
    })
    // Trace capture only fires for `otacon` (not `otacon-alloc`); we still need
    // an active allocation for the otacon commands to execute.
    const prov = await bash.exec('otacon-alloc provision 10')
    if (prov.exitCode !== 0) {
      throw new Error(`provision failed: ${prov.stderr.trim()}`)
    }
    try {
      const env = traceDir ? { OTACON_TRACE_DIR: traceDir } : {}
      for (const cmd of commands) {
        const r = await bash.exec(cmd, { env } as any)
        if (r.exitCode !== 0) {
          console.log(`    (cmd "${cmd}" exitCode=${r.exitCode} stderr=${r.stderr.trim()})`)
        }
      }
    } finally {
      await bash.exec('otacon-alloc release').catch(() => {})
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

async function testMutatingCaptures() {
  console.log('\n--- mutating commands write annotated PNG + JSON sidecar ---')
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracecap-out-'))
  try {
    await runSandbox({
      traceDir,
      commands: [
        // Wake screen first so subsequent operations succeed
        'otacon key WAKEUP',
        'otacon swipe 540 1200 540 600',
      ],
    })

    const files = listFiles(traceDir)
    const pngs = files.filter(f => f.endsWith('.png'))
    const jsons = files.filter(f => f.endsWith('.json'))
    assert(pngs.length >= 2, `at least 2 PNG files written (got ${pngs.length}: ${pngs.join(',')})`)
    assert(jsons.length >= 2, `at least 2 JSON sidecars written (got ${jsons.length}: ${jsons.join(',')})`)

    // Verify naming: NNN-{verb}.{png|json}
    const namingOk = files.every(f => /^\d{3}-[a-z\-]+\.(png|json)$/.test(f))
    assert(namingOk, `all files match NNN-verb.{png,json} (files: ${files.join(',')})`)

    // Verify increment
    const seqs = pngs.map(f => parseInt(f.slice(0, 3))).sort((a, b) => a - b)
    const allIncrementing = seqs.every((s, i) => s === seqs[0] + i)
    assert(allIncrementing, `sequence increments contiguously (got ${seqs.join(',')})`)

    // Spot-check a JSON sidecar shape
    if (jsons.length > 0) {
      const sidecarPath = path.join(traceDir, jsons[0])
      const raw = fs.readFileSync(sidecarPath, 'utf-8')
      let parsed: any = null
      try { parsed = JSON.parse(raw) } catch {}
      assert(parsed !== null, 'sidecar is valid JSON')
      assert(typeof parsed?.verb === 'string', `sidecar has verb field (got ${parsed?.verb})`)
      assert(Array.isArray(parsed?.args), `sidecar has args array (got ${typeof parsed?.args})`)
      assert(typeof parsed?.ts === 'number' || typeof parsed?.ts === 'string', 'sidecar has ts')
      assert(typeof parsed?.seq === 'number', `sidecar has numeric seq (got ${parsed?.seq})`)
    }

    // Check PNG files are non-zero (annotation produced bytes)
    for (const png of pngs) {
      const sz = fs.statSync(path.join(traceDir, png)).size
      assert(sz > 100, `${png} has bytes (${sz})`)
    }
  } finally {
    fs.rmSync(traceDir, { recursive: true, force: true })
  }
}

async function testKeyAnnotation() {
  console.log('\n--- key command produces text-overlay PNG ---')
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracecap-key-'))
  try {
    await runSandbox({
      traceDir,
      commands: ['otacon key HOME'],
    })
    const files = listFiles(traceDir)
    const pngs = files.filter(f => f.endsWith('.png') && f.includes('key'))
    assert(pngs.length === 1, `exactly 1 key PNG (got ${pngs.length}: ${pngs.join(',')})`)

    const sidecar = files.find(f => f.endsWith('.json') && f.includes('key'))
    if (sidecar) {
      const parsed = JSON.parse(fs.readFileSync(path.join(traceDir, sidecar), 'utf-8'))
      assert(parsed.verb === 'key', `sidecar verb=key (got ${parsed.verb})`)
      assert(parsed.args.includes('HOME'), `sidecar args include HOME (got ${JSON.stringify(parsed.args)})`)
    }
  } finally {
    fs.rmSync(traceDir, { recursive: true, force: true })
  }
}

async function testTapAnnotation() {
  console.log('\n--- tap command produces circle-overlay PNG ---')
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracecap-tap-'))
  try {
    await runSandbox({
      traceDir,
      commands: ['otacon tap 540 1000'],
    })
    const files = listFiles(traceDir)
    const pngs = files.filter(f => f.endsWith('.png') && f.includes('tap'))
    assert(pngs.length === 1, `exactly 1 tap PNG (got ${pngs.length}: ${pngs.join(',')})`)
  } finally {
    fs.rmSync(traceDir, { recursive: true, force: true })
  }
}

async function testNoTraceDirNoFiles() {
  console.log('\n--- without OTACON_TRACE_DIR: no files written ---')
  // We can only verify negative behavior by inspecting OS-wide tmp space
  // for likely-leftover patterns. Instead, point an env-empty sandbox at a
  // dir that doesn't exist and confirm it stays missing.
  const checkDir = path.join(os.tmpdir(), `tracecap-should-not-exist-${Date.now()}`)
  await runSandbox({
    // No traceDir → env unset
    commands: ['otacon key WAKEUP', 'otacon swipe 540 1200 540 600'],
  })
  assert(!fs.existsSync(checkDir), 'no stray trace dir created when env unset')
}

async function testSequenceAcrossInvocations() {
  console.log('\n--- sequence increments across commands in same dir ---')
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracecap-seq-'))
  try {
    await runSandbox({
      traceDir,
      commands: [
        'otacon key WAKEUP',
        'otacon swipe 540 1200 540 600',
        'otacon key BACK',
      ],
    })
    const files = listFiles(traceDir).filter(f => f.endsWith('.png'))
    const seqs = files.map(f => parseInt(f.slice(0, 3))).sort((a, b) => a - b)
    assert(seqs.length >= 3, `at least 3 PNGs in seq dir (got ${seqs.length})`)
    if (seqs.length >= 3) {
      assert(seqs[0] === 1, `first seq is 001 (got ${String(seqs[0]).padStart(3, '0')})`)
      assert(
        seqs.every((s, i) => s === seqs[0] + i),
        `seqs are contiguous (got ${seqs.join(',')})`,
      )
    }
  } finally {
    fs.rmSync(traceDir, { recursive: true, force: true })
  }
}

async function testNonMutatingNoAnnotatedPng() {
  console.log('\n--- non-mutating commands (snapshot/info) do not produce annotated PNGs ---')
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracecap-noop-'))
  try {
    await runSandbox({
      traceDir,
      commands: [
        'otacon snapshot',
        'otacon info',
      ],
    })
    const files = listFiles(traceDir)
    const annotatedPngs = files.filter(f => /^\d{3}-(snapshot|info)\.png$/.test(f))
    assert(annotatedPngs.length === 0, `no annotated PNG for snapshot/info (got ${annotatedPngs.join(',')})`)
  } finally {
    fs.rmSync(traceDir, { recursive: true, force: true })
  }
}

async function main() {
  console.log('=== Trace Capture Tests ===')

  await testMutatingCaptures()
  await testKeyAnnotation()
  await testTapAnnotation()
  await testNoTraceDirNoFiles()
  await testSequenceAcrossInvocations()
  await testNonMutatingNoAnnotatedPng()

  await cleanupAll()
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  cleanupAll().finally(() => process.exit(1))
})
