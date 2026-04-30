/**
 * Unit tests for the Phase 6 architecture decision:
 *
 *   1. WorkflowAgent's writable expects ModelCallStreamPart (model-level
 *      chunks). Custom `data-*` UIMessageChunks written to it are silently
 *      dropped by `createModelCallToUIChunkTransform()`.
 *   2. The route handler must split custom data emission into its own
 *      namespaced workflow stream and merge BOTH streams (transformed
 *      ModelCallStreamPart + raw UIMessageChunk) into one response via
 *      `createUIMessageStream({ writer.merge(...) })`.
 *   3. Round-tripping a `data-phone-action` chunk through the merge must
 *      preserve its shape — the chunk is a UIMessageChunk on the wire, so
 *      it must pass `parseJsonEventStream` unmodified on the client.
 *
 * These behaviors are load-bearing for P6 (`docs/orchestrator-v2-plan.md`
 * §"Phase 6"). If the AI SDK changes the transform's swallow-by-default
 * behavior, this test fails fast and we adjust.
 *
 * Run: npx tsx tests/orchestrator/unit/test-namespaced-stream-merge.ts
 */
// Use type-only imports so tsx (CJS shim) can load these packages via
// dynamic import inside main() — the AI SDK v7-beta packages are
// ESM-only and tsx's classic loader hits ERR_REQUIRE_CYCLE_MODULE on
// top-level synchronous import in this layout.
import type { ModelCallStreamPart } from '@ai-sdk/workflow'
import type { UIMessageChunk } from 'ai'

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  PASS  ${msg}`)
    passed++
  } else {
    console.log(`  FAIL  ${msg}`)
    failed++
  }
}

function assertEq<T>(actual: T, expected: T, msg: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    console.log(`  PASS  ${msg}`)
    passed++
  } else {
    console.log(`  FAIL  ${msg}`)
    console.log(`        expected: ${JSON.stringify(expected)}`)
    console.log(`        actual  : ${JSON.stringify(actual)}`)
    failed++
  }
}

async function readAll<T>(readable: ReadableStream<T>): Promise<T[]> {
  const out: T[] = []
  const reader = readable.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) out.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return out
}

function makeReadable<T>(parts: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const p of parts) controller.enqueue(p)
      controller.close()
    },
  })
}

// Dynamically resolved at test start; populated in main().
let createModelCallToUIChunkTransform: typeof import('@ai-sdk/workflow').createModelCallToUIChunkTransform
let toUIMessageChunk: typeof import('@ai-sdk/workflow').toUIMessageChunk
let createUIMessageStream: typeof import('ai').createUIMessageStream
let uiMessageChunkSchema: typeof import('ai').uiMessageChunkSchema

async function testToUIMessageChunkDropsCustomData() {
  console.log('toUIMessageChunk drops custom data-* parts')

  // Model-level parts that DO map.
  const textDelta = toUIMessageChunk({
    type: 'text-delta',
    id: 'msg-1',
    text: 'hello',
  } as ModelCallStreamPart)
  assert(textDelta?.type === 'text-delta', 'text-delta maps to UIMessageChunk')

  const toolInput = toUIMessageChunk({
    type: 'tool-input-start',
    id: 'tc-1',
    toolName: 'bash',
  } as ModelCallStreamPart)
  assert(toolInput?.type === 'tool-input-start', 'tool-input-start maps')

  // Custom data-* part — would be SILENTLY DROPPED if written to the
  // agent's writable. This is the core risk we're mitigating.
  const phoneAction = toUIMessageChunk({
    type: 'data-phone-action',
    id: 'pa-1',
    data: { command: 'otacon tap e5' },
  } as unknown as ModelCallStreamPart)
  assert(phoneAction === undefined, 'data-phone-action is silently dropped (the bug we work around)')

  const runStarted = toUIMessageChunk({
    type: 'data-run-started',
    id: 'rs-1',
    data: { run_id: 'r-1' },
  } as unknown as ModelCallStreamPart)
  assert(runStarted === undefined, 'data-run-started is silently dropped')
}

async function testTransformSurvivesKnownChunks() {
  console.log('createModelCallToUIChunkTransform surrounds known parts with start/start-step/finish-step/finish')

  const input: ModelCallStreamPart[] = [
    { type: 'text-start', id: 'msg-1' } as ModelCallStreamPart,
    { type: 'text-delta', id: 'msg-1', text: 'Hi' } as ModelCallStreamPart,
    { type: 'text-end', id: 'msg-1' } as ModelCallStreamPart,
  ]
  const transformed = makeReadable(input).pipeThrough(createModelCallToUIChunkTransform())
  const out = await readAll(transformed)

  // The transform wraps with start + start-step on open, finish-step + finish on close.
  assertEq(
    out.map(c => c.type),
    ['start', 'start-step', 'text-start', 'text-delta', 'text-end', 'finish-step', 'finish'],
    'transform output sequence',
  )
}

async function testTransformDropsCustomDataInline() {
  console.log('createModelCallToUIChunkTransform drops custom data-* parts inline (end-to-end)')

  const input = [
    { type: 'text-delta', id: 'msg-1', text: 'A' },
    // Pretend someone wrote a custom data-* into the agent's writable.
    { type: 'data-phone-action', id: 'pa-1', data: { command: 'tap' } },
    { type: 'text-delta', id: 'msg-1', text: 'B' },
  ] as ModelCallStreamPart[]

  const transformed = makeReadable(input).pipeThrough(createModelCallToUIChunkTransform())
  const out = await readAll(transformed)

  const types = out.map(c => c.type)
  assert(!types.includes('data-phone-action'), 'data-phone-action does NOT survive the transform')
  assert(types.includes('text-delta'), 'text-delta survives')
  assertEq(
    types,
    ['start', 'start-step', 'text-delta', 'text-delta', 'finish-step', 'finish'],
    'only model-level chunks pass through; data-* chunk silently dropped',
  )
}

async function testCreateUIMessageStreamMergesBothNamespaces() {
  console.log('createUIMessageStream + writer.merge fuses two UIMessageChunk streams')

  // Simulating: route handler grabs the agent's ModelCallStreamPart readable
  // (transformed) AND the data-namespace UIMessageChunk readable, merges
  // both into one outgoing stream. The data namespace bypasses the
  // ModelCallStreamPart→UIMessageChunk transform because it's already in
  // the right shape.
  const modelPart = makeReadable([
    { type: 'text-delta', id: 'msg-1', text: 'hello' },
  ] as ModelCallStreamPart[]).pipeThrough(createModelCallToUIChunkTransform())

  const dataPart = makeReadable<UIMessageChunk>([
    {
      type: 'data-phone-action',
      id: 'pa-1',
      data: { command: 'otacon tap e5' },
    } as unknown as UIMessageChunk,
    {
      type: 'data-run-started',
      id: 'rs-1',
      data: { run_id: 'r-1' },
    } as unknown as UIMessageChunk,
  ])

  const merged = createUIMessageStream({
    execute: ({ writer }) => {
      writer.merge(modelPart)
      writer.merge(dataPart)
    },
  })
  const out = await readAll(merged)
  const types = out.map(c => c.type)

  assert(types.includes('text-delta'), 'text-delta from model namespace flowed through')
  assert(types.includes('data-phone-action'), 'data-phone-action from data namespace flowed through')
  assert(types.includes('data-run-started'), 'data-run-started from data namespace flowed through')

  // Shape preservation — the data-phone-action chunk reached the consumer
  // with its `data` payload intact.
  const phoneAction = out.find(c => c.type === 'data-phone-action') as unknown as { id: string; data: unknown }
  assert(phoneAction !== undefined, 'data-phone-action chunk present in merged output')
  assertEq(
    phoneAction.data,
    { command: 'otacon tap e5' },
    'data-phone-action payload preserved through merge',
  )
}

async function testParsesUiMessageChunkSchema() {
  console.log('uiMessageChunkSchema accepts our data-* chunks (via WorkflowChatTransport client parser)')

  // The transport uses parseJsonEventStream + uiMessageChunkSchema on the
  // client. If our chunks don't validate, useChat errors out. AI SDK
  // v7-beta exposes `uiMessageChunkSchema` as a LazySchema (callable
  // `() => Schema<...>`); the resolved Schema has `.validate(value) →
  // { success, value | error }`.
  type Schema = { validate(v: unknown): Promise<{ success: boolean; error?: unknown }> }
  const schema = (uiMessageChunkSchema as unknown as () => Schema)()

  const result = await schema.validate({
    type: 'data-phone-action',
    id: 'pa-1',
    data: { command: 'otacon tap e5' },
  })
  assert(result.success, 'data-phone-action chunk is valid against uiMessageChunkSchema')

  const result2 = await schema.validate({
    type: 'data-run-started',
    id: 'rs-1',
    data: { run_id: 'r-1' },
  })
  assert(result2.success, 'data-run-started chunk is valid against uiMessageChunkSchema')

  const result3 = await schema.validate({
    type: 'tool-approval-request',
    approvalId: 'apr-1',
    toolCallId: 'tc-1',
  })
  assert(result3.success, 'tool-approval-request chunk is valid (AI SDK approval primitive)')
}

async function main() {
  // Resolve via the orchestrator workspace's node_modules — the test
  // file's package boundary doesn't have these deps installed; the
  // orchestrator package does. Using a relative import resolves through
  // the orchestrator's package.json + node_modules.
  const wf = await import('../../../src/orchestrator/node_modules/@ai-sdk/workflow/dist/index.mjs')
  const ai = await import('../../../src/orchestrator/node_modules/ai/dist/index.js')
  createModelCallToUIChunkTransform = wf.createModelCallToUIChunkTransform
  toUIMessageChunk = wf.toUIMessageChunk
  createUIMessageStream = ai.createUIMessageStream
  uiMessageChunkSchema = ai.uiMessageChunkSchema

  await testToUIMessageChunkDropsCustomData()
  console.log()
  await testTransformSurvivesKnownChunks()
  console.log()
  await testTransformDropsCustomDataInline()
  console.log()
  await testCreateUIMessageStreamMergesBothNamespaces()
  console.log()
  await testParsesUiMessageChunkSchema()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
