/**
 * Tests for LocalBlobStore: write, read, list, delete, exists, path traversal.
 * Run: npx tsx tests/orchestrator/test-blob-storage.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { LocalBlobStore } from '../../src/orchestrator/src/storage/blob.js'

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

async function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-test-'))
}

async function teardown() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

async function testWriteAndRead() {
  console.log('\n--- write + read ---')
  const store = new LocalBlobStore(tmpDir)
  await store.write('test/hello.txt', 'hello world')
  const data = await store.read('test/hello.txt')
  assert(data !== null, 'read returns non-null')
  assert(data!.toString('utf-8') === 'hello world', 'content matches')
}

async function testReadMissing() {
  console.log('\n--- read missing ---')
  const store = new LocalBlobStore(tmpDir)
  const data = await store.read('does/not/exist.txt')
  assert(data === null, 'missing file returns null')
}

async function testExists() {
  console.log('\n--- exists ---')
  const store = new LocalBlobStore(tmpDir)
  await store.write('exists-test/file.txt', 'data')
  assert(await store.exists('exists-test/file.txt') === true, 'exists returns true for written file')
  assert(await store.exists('exists-test/nope.txt') === false, 'exists returns false for missing file')
}

async function testList() {
  console.log('\n--- list ---')
  const store = new LocalBlobStore(tmpDir)
  await store.write('list-test/a.txt', 'a')
  await store.write('list-test/b.txt', 'b')
  await store.write('list-test/sub/c.txt', 'c')
  const files = await store.list('list-test')
  assert(files.length === 3, `list returns 3 files (got ${files.length})`)
  assert(files.includes('list-test/a.txt'), 'list includes a.txt')
  assert(files.includes('list-test/b.txt'), 'list includes b.txt')
  assert(files.includes('list-test/sub/c.txt'), 'list includes sub/c.txt')
}

async function testListEmpty() {
  console.log('\n--- list empty prefix ---')
  const store = new LocalBlobStore(tmpDir)
  const files = await store.list('nonexistent-prefix')
  assert(files.length === 0, 'list of missing prefix returns empty array')
}

async function testDelete() {
  console.log('\n--- delete ---')
  const store = new LocalBlobStore(tmpDir)
  await store.write('delete-test/file.txt', 'to delete')
  assert(await store.exists('delete-test/file.txt') === true, 'file exists before delete')
  await store.delete('delete-test/file.txt')
  assert(await store.exists('delete-test/file.txt') === false, 'file gone after delete')
  const data = await store.read('delete-test/file.txt')
  assert(data === null, 'read after delete returns null')
}

async function testWriteBuffer() {
  console.log('\n--- write buffer ---')
  const store = new LocalBlobStore(tmpDir)
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]) // PNG magic bytes
  await store.write('binary/test.png', buf)
  const data = await store.read('binary/test.png')
  assert(data !== null, 'binary read returns non-null')
  assert(data![0] === 0x89 && data![1] === 0x50, 'binary content preserved')
}

async function testPathTraversal() {
  console.log('\n--- path traversal protection ---')
  const store = new LocalBlobStore(tmpDir)
  let caught = false
  try {
    await store.read('../../etc/passwd')
  } catch (e: any) {
    caught = e.message.includes('path traversal')
  }
  assert(caught, 'path traversal blocked on read')
}

async function testSub() {
  console.log('\n--- sub store ---')
  const store = new LocalBlobStore(tmpDir)
  const sub = store.sub('accounts/test')
  await sub.write('workspace/notes.md', '# Notes')
  const data = await store.read('accounts/test/workspace/notes.md')
  assert(data !== null, 'sub-store write visible from parent')
  assert(data!.toString('utf-8') === '# Notes', 'content matches via parent')
}

async function testOverwrite() {
  console.log('\n--- overwrite ---')
  const store = new LocalBlobStore(tmpDir)
  await store.write('overwrite/file.txt', 'v1')
  await store.write('overwrite/file.txt', 'v2')
  const data = await store.read('overwrite/file.txt')
  assert(data!.toString('utf-8') === 'v2', 'overwrite replaces content')
}

async function main() {
  console.log('=== LocalBlobStore Tests ===')
  await setup()
  try {
    await testWriteAndRead()
    await testReadMissing()
    await testExists()
    await testList()
    await testListEmpty()
    await testDelete()
    await testWriteBuffer()
    await testPathTraversal()
    await testSub()
    await testOverwrite()
  } finally {
    await teardown()
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
