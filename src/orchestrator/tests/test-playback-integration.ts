/**
 * Trace → playback report integration regression test.
 *
 * For a fresh agent run, every mutating bash tool call in the conversation
 * must produce an embedded screenshot in the inspect-conversation report,
 * and the linked PNG must exist on disk under
 * `<blobRoot>/conversations/<id>/traces/<toolCallId>/`.
 *
 * This stitches the pieces verified in isolation by:
 *   - test-trace-capture.ts (PNG + sidecar produced when env set)
 *   - test-inspect.ts       (markdown generator emits image links)
 *   - test-e2e.ts           (agent runs end to end)
 *
 * If a future regression breaks any of: bash tool wrapper trace dir,
 * blob path resolution, or report image-link emission — this test fails.
 *
 * The test reads recorded artifacts from a freshly-run conversation; it does
 * NOT spawn the orchestrator subprocess (the e2e test handles that). Instead,
 * it requires that some mutating tool call has already been recorded for
 * `xhs:test`. Pass --conversation <id> to target a specific run; otherwise
 * the most-recent conversation in the blob store is used.
 *
 * Run: npx tsx tests/test-playback-integration.ts [--conversation <id>]
 */
import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMutating } from '../src/sandbox/build.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ORCHESTRATOR_DIR = path.resolve(__dirname, '..')
const BLOB_ROOT = path.join(ORCHESTRATOR_DIR, '.orchestrator-data/blobs')

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) { console.log(`  PASS  ${msg}`); passed++ }
  else { console.log(`  FAIL  ${msg}`); failed++ }
}

interface ToolCall {
  toolCallId: string
  toolName: string
  command: string
  rationale?: string
}

function loadMessages(conversationId: string): any[] {
  const dir = path.join(BLOB_ROOT, 'conversations', conversationId, 'messages')
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
  return files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')))
}

function extractToolCalls(messages: any[]): ToolCall[] {
  const calls: ToolCall[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const parts = Array.isArray(msg.content) ? msg.content : []
    for (const part of parts) {
      if (part.type !== 'tool-call' || part.toolName !== 'bash') continue
      const input = part.input ?? part.args ?? {}
      const command = input.command
      if (typeof command !== 'string') continue
      calls.push({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        command,
        rationale: input.rationale,
      })
    }
  }
  return calls
}

function findMostRecentConversation(): string | null {
  const dir = path.join(BLOB_ROOT, 'conversations')
  if (!fs.existsSync(dir)) return null
  const entries = fs.readdirSync(dir)
    .filter(d => fs.statSync(path.join(dir, d)).isDirectory())
    .map(d => ({ id: d, mtime: fs.statSync(path.join(dir, d)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime)
  return entries[0]?.id ?? null
}

function generateInspectReport(conversationId: string): string | null {
  const r = spawnSync('npx', ['tsx', 'src/index.ts', 'inspect', 'conversation', conversationId], {
    cwd: ORCHESTRATOR_DIR,
    encoding: 'utf-8',
    timeout: 60_000,
  })
  if (r.status !== 0) {
    console.log(`  (inspect conversation failed: stderr=${r.stderr?.trim()})`)
    return null
  }
  // Output line: "Report written to: <relpath>"
  const m = r.stdout.match(/Report written to:\s*(\S+)/)
  if (!m) return null
  // Path is relative to ORCHESTRATOR_DIR (matches the inspect command's cwd-relative usage)
  return path.resolve(ORCHESTRATOR_DIR, m[1])
}

function main() {
  console.log('=== Trace → Report Integration Test ===')

  const argIdx = process.argv.indexOf('--conversation')
  const conversationId = argIdx >= 0 ? process.argv[argIdx + 1] : findMostRecentConversation()

  if (!conversationId) {
    console.log('  FAIL  No conversation found. Run an agent first or pass --conversation <id>.')
    process.exit(1)
  }
  console.log(`  conversation: ${conversationId}`)

  // 1. Load messages and extract bash tool calls
  const messages = loadMessages(conversationId)
  assert(messages.length > 0, `loaded messages from blob (got ${messages.length})`)

  const toolCalls = extractToolCalls(messages)
  console.log(`  total bash tool calls: ${toolCalls.length}`)

  // Filter to mutating commands
  const mutatingCalls = toolCalls.filter(c => isMutating(c.command))
  console.log(`  mutating tool calls: ${mutatingCalls.length}`)

  if (mutatingCalls.length === 0) {
    console.log('  FAIL  Conversation has no mutating bash tool calls — nothing to verify.')
    console.log('        Run an agent that performs at least one tap/swipe/key/etc., then re-run.')
    process.exit(1)
  }
  passed++  // count "has at least one mutating call" as a pass

  // 2. Generate the inspect report
  const reportPath = generateInspectReport(conversationId)
  assert(reportPath !== null, `inspect conversation generated a report`)
  if (!reportPath) { process.exit(1) }
  assert(fs.existsSync(reportPath), `report file exists at ${reportPath}`)

  const reportText = fs.readFileSync(reportPath, 'utf-8')
  assert(reportText.length > 100, `report has content (${reportText.length} chars)`)

  // 3. For each mutating tool call, assert there is a matching ![](path) image
  //    in the same section AND that the file exists on disk.
  const reportDir = path.dirname(reportPath)

  for (const call of mutatingCalls) {
    const toolCallId = call.toolCallId
    // Image links emitted by the inspect command have the form:
    //   ![<png-name>](../traces/<toolCallId>/<png-name>)
    const imgPattern = new RegExp(
      `!\\[[^\\]]*\\]\\(\\.\\./traces/${toolCallId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^)]+\\.png\\)`,
    )
    const found = imgPattern.test(reportText)
    assert(found, `report references PNG for ${call.toolCallId} (${call.command.slice(0, 40)})`)
    if (!found) continue

    // Resolve and verify the linked file
    const matches = [...reportText.matchAll(
      new RegExp(`!\\[[^\\]]*\\]\\((\\.\\./traces/${toolCallId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^)]+\\.png)\\)`, 'g'),
    )]
    for (const m of matches) {
      const rel = m[1]
      const abs = path.resolve(reportDir, rel)
      const exists = fs.existsSync(abs)
      assert(exists, `linked PNG exists on disk: ${rel}`)
      if (exists) {
        const sz = fs.statSync(abs).size
        assert(sz > 100, `linked PNG has bytes (${sz}) for ${rel}`)
      }
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
