/**
 * Tests for conversation persistence: saveConversation / loadConversation round-trip.
 * Run: npx tsx tests/orchestrator/test-conversation.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { LocalBlobStore } from '../../src/orchestrator/src/storage/blob.js'
import { saveConversation, loadConversation } from '../../src/orchestrator/src/storage/conversation.js'

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-test-'))
}

async function teardown() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

async function testSaveAndLoad() {
  console.log('\n--- save + load round-trip ---')
  const store = new LocalBlobStore(tmpDir)
  const convId = 'test-conv-001'
  const messages = [
    { role: 'system' as const, content: 'You are a helpful assistant.' },
    { role: 'user' as const, content: 'Hello' },
    { role: 'assistant' as const, content: 'Hi there!' },
  ]

  await saveConversation(store, convId, messages)
  const loaded = await loadConversation(store, convId)

  assert(loaded.length === 3, `loaded 3 messages (got ${loaded.length})`)
  assert((loaded[0] as any).role === 'system', 'first message is system')
  assert((loaded[1] as any).content === 'Hello', 'user message content preserved')
  assert((loaded[2] as any).content === 'Hi there!', 'assistant message content preserved')
}

async function testLoadEmpty() {
  console.log('\n--- load nonexistent conversation ---')
  const store = new LocalBlobStore(tmpDir)
  const loaded = await loadConversation(store, 'does-not-exist')
  assert(loaded.length === 0, 'empty conversation returns empty array')
}

async function testMessageOrdering() {
  console.log('\n--- message ordering ---')
  const store = new LocalBlobStore(tmpDir)
  const convId = 'test-conv-order'
  const messages = Array.from({ length: 15 }, (_, i) => ({
    role: 'user' as const,
    content: `message ${i + 1}`,
  }))

  await saveConversation(store, convId, messages)
  const loaded = await loadConversation(store, convId)

  assert(loaded.length === 15, `loaded 15 messages (got ${loaded.length})`)
  for (let i = 0; i < 15; i++) {
    const expected = `message ${i + 1}`
    const actual = (loaded[i] as any).content
    if (actual !== expected) {
      assert(false, `message ${i + 1} out of order: got "${actual}"`)
      return
    }
  }
  assert(true, 'all 15 messages in correct order')
}

async function testAppendMessages() {
  console.log('\n--- append messages (simulate resume) ---')
  const store = new LocalBlobStore(tmpDir)
  const convId = 'test-conv-append'

  // Initial save
  const initial = [
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'reply' },
  ]
  await saveConversation(store, convId, initial)

  // Simulate resume: load, add more, save
  const loaded = await loadConversation(store, convId)
  const extended = [
    ...loaded,
    { role: 'user' as const, content: 'second' },
    { role: 'assistant' as const, content: 'reply2' },
  ]
  await saveConversation(store, convId, extended)

  const final = await loadConversation(store, convId)
  assert(final.length === 4, `4 messages after append (got ${final.length})`)
  assert((final[0] as any).content === 'first', 'first message preserved')
  assert((final[3] as any).content === 'reply2', 'appended message present')
}

async function testToolMessages() {
  console.log('\n--- tool call messages ---')
  const store = new LocalBlobStore(tmpDir)
  const convId = 'test-conv-tools'
  const messages = [
    { role: 'user' as const, content: 'take a screenshot' },
    {
      role: 'assistant' as const,
      content: [
        { type: 'tool-call' as const, toolCallId: 'tc1', toolName: 'bash', args: { command: 'otacon screenshot' } },
      ],
    },
    {
      role: 'tool' as const,
      content: [
        { type: 'tool-result' as const, toolCallId: 'tc1', result: '[screenshot: 15000 bytes]' },
      ],
    },
  ]

  await saveConversation(store, convId, messages as any)
  const loaded = await loadConversation(store, convId)

  assert(loaded.length === 3, `loaded 3 messages including tool (got ${loaded.length})`)
  const toolCall = loaded[1] as any
  assert(Array.isArray(toolCall.content), 'assistant content is array (tool-call)')
  assert(toolCall.content[0].toolName === 'bash', 'tool name preserved')
  assert(toolCall.content[0].args.command === 'otacon screenshot', 'tool args preserved')
}

async function testFileNumbering() {
  console.log('\n--- file numbering format ---')
  const store = new LocalBlobStore(tmpDir)
  const convId = 'test-conv-numbering'
  const messages = [
    { role: 'user' as const, content: 'hello' },
  ]

  await saveConversation(store, convId, messages)
  const files = await store.list(`conversations/${convId}/messages`)
  assert(files.length === 1, 'one message file')
  assert(files[0].endsWith('00001.json'), `file named 00001.json (got ${files[0]})`)
}

async function main() {
  console.log('=== Conversation Persistence Tests ===')
  await setup()
  try {
    await testSaveAndLoad()
    await testLoadEmpty()
    await testMessageOrdering()
    await testAppendMessages()
    await testToolMessages()
    await testFileNumbering()
  } finally {
    await teardown()
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
