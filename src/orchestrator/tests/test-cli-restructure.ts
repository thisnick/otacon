/**
 * CLI restructure tests — Phase A.2 task #8.
 *
 * Verifies the orchestrator CLI now exposes three top-level groups:
 *   pnpm orchestrator service   { add-account, migrate, generate }
 *   pnpm orchestrator agent     { run }
 *   pnpm orchestrator inspect   { conversations, conversation, state, schema, commands, logs }
 *
 * Old top-level commands (run, add-account, status, logs, db:migrate, db:generate)
 * stay around with a deprecation notice for one phase.
 *
 * These are all surface tests — we invoke `--help` and a no-op subcommand
 * to confirm the parser accepts the new groups, without spending DB/phone time.
 *
 * Run: npx tsx tests/test-cli-restructure.ts
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ORCHESTRATOR_DIR = path.resolve(__dirname, '..')

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) { console.log(`  PASS  ${msg}`); passed++ }
  else { console.log(`  FAIL  ${msg}`); failed++ }
}

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync('npx', ['tsx', 'src/index.ts', ...args], {
    cwd: ORCHESTRATOR_DIR,
    encoding: 'utf-8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    timeout: 30_000,
  })
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    exitCode: r.status ?? -1,
  }
}

function combined(r: { stdout: string; stderr: string }): string {
  return `${r.stdout}\n${r.stderr}`
}

function testTopLevelHelp() {
  console.log('\n--- top-level --help mentions service / agent / inspect ---')
  const r = run(['--help'])
  assert(r.exitCode === 0, `--help exit 0 (stderr: ${r.stderr.trim()})`)
  const out = combined(r)
  assert(out.includes('service'), '--help lists "service" group')
  assert(out.includes('agent'), '--help lists "agent" group')
  assert(out.includes('inspect'), '--help lists "inspect" group')
}

function testServiceHelp() {
  console.log('\n--- service --help lists subcommands ---')
  const r = run(['service', '--help'])
  assert(r.exitCode === 0, `service --help exit 0 (stderr: ${r.stderr.trim()})`)
  const out = combined(r)
  for (const sub of ['add-account', 'migrate', 'generate']) {
    assert(out.includes(sub), `service --help lists "${sub}"`)
  }
}

function testAgentHelp() {
  console.log('\n--- agent --help lists subcommands ---')
  const r = run(['agent', '--help'])
  assert(r.exitCode === 0, `agent --help exit 0 (stderr: ${r.stderr.trim()})`)
  const out = combined(r)
  assert(out.includes('run'), 'agent --help lists "run"')
}

function testInspectHelp() {
  console.log('\n--- inspect --help lists subcommands ---')
  const r = run(['inspect', '--help'])
  assert(r.exitCode === 0, `inspect --help exit 0 (stderr: ${r.stderr.trim()})`)
  const out = combined(r)
  for (const sub of ['conversations', 'conversation', 'state', 'schema', 'commands', 'logs']) {
    assert(out.includes(sub), `inspect --help lists "${sub}"`)
  }
}

function testServiceAddAccountHelp() {
  console.log('\n--- service add-account --help shows expected flags ---')
  const r = run(['service', 'add-account', '--help'])
  assert(r.exitCode === 0, `add-account --help exit 0 (stderr: ${r.stderr.trim()})`)
  const out = combined(r)
  assert(out.includes('--id'), 'add-account --help mentions --id')
  assert(out.includes('--phone-number'), 'add-account --help mentions --phone-number')
}

function testAgentRunHelp() {
  console.log('\n--- agent run --help shows expected flags ---')
  const r = run(['agent', 'run', '--help'])
  assert(r.exitCode === 0, `agent run --help exit 0 (stderr: ${r.stderr.trim()})`)
  const out = combined(r)
  assert(out.includes('--account'), 'agent run --help mentions --account')
  assert(out.includes('--team'), 'agent run --help mentions --team')
  assert(out.includes('--prompt'), 'agent run --help mentions --prompt')
}

function testOldCommandsDeprecated() {
  console.log('\n--- old top-level commands print deprecation but still work ---')
  // Legacy commands are intentionally hidden from top-level --help to keep
  // the new CLI clean. They remain invokable for one phase and must print
  // a deprecation notice. Verify each by invoking <cmd> --help and checking
  // the help text or deprecation marker.
  for (const cmd of ['run', 'add-account', 'logs']) {
    const r = run([cmd, '--help'])
    const out = combined(r)
    assert(r.exitCode === 0, `${cmd} --help exit 0 (stderr: ${r.stderr.trim()})`)
    assert(out.includes('deprecated') || out.toLowerCase().includes('deprecated'),
      `${cmd} --help mentions deprecated`)
  }
  // `status` doesn't take --help (no subargs), so invoke it directly. It still
  // works (queries DB); we accept either a deprecation notice on stdout/stderr
  // or successful execution as evidence the legacy entry point exists.
  const status = run(['status'])
  const statusOut = combined(status)
  assert(
    status.exitCode === 0 || statusOut.toLowerCase().includes('deprecated'),
    `legacy "status" still invokable (exit ${status.exitCode}, deprecated mentioned: ${statusOut.toLowerCase().includes('deprecated')})`,
  )
}

function testInspectSchemaSmoke() {
  console.log('\n--- inspect schema smoke test ---')
  if (!process.env.DATABASE_URL && !fs.existsSync(path.join(ORCHESTRATOR_DIR, '.env'))) {
    console.log('  SKIP  DATABASE_URL not set, skipping schema test')
    return
  }
  const r = run(['inspect', 'schema'])
  assert(r.exitCode === 0, `inspect schema runs (stderr: ${r.stderr.trim()})`)
}

function main() {
  console.log('=== CLI Restructure Tests ===')

  testTopLevelHelp()
  testServiceHelp()
  testAgentHelp()
  testInspectHelp()
  testServiceAddAccountHelp()
  testAgentRunHelp()
  testOldCommandsDeprecated()
  testInspectSchemaSmoke()

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
