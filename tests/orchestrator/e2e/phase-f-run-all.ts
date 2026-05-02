/**
 * Phase F sign-off runner.
 *
 * Ordering matters because of phone-4 single-resource lock + F7's dependency
 * on F8's traces:
 *
 *   F1 (API smoke; light-touch run, parallel-safe with non-phone scenarios
 *       but for simplicity runs first)
 *   F8 (canonical XHS run, ~3-8 min, phone-4)
 *   F7 (reads F8's traces — fast, no phone)
 *   F6 (resume-by-team, phone-4 — memory-only prompts but resolves phone)
 *   F5 (approval flows, phone-4)
 *   F3 (local serve + ui — local data dir, no shared phone state)
 *   F4 (remote ui via VPS — no phone)
 *
 * If F1 is failing, downstream scenarios will likely also fail; runner does
 * NOT abort, so the operator gets the full picture in one pass.
 *
 * Each scenario is its own child process — failure in one doesn't crash
 * others.
 *
 * Run:
 *   pnpm test:e2e:phase-f
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SCENARIOS = [
  { id: 'F1', file: 'phase-f1-api-smoke.ts' },
  { id: 'F8', file: 'phase-f8-phone4-canonical.ts' },
  { id: 'F7', file: 'phase-f7-trace-png-serving.ts' },
  { id: 'F6', file: 'phase-f6-resume-by-team.ts' },
  { id: 'F5', file: 'phase-f5-approval-from-ui.ts' },
  { id: 'F3', file: 'phase-f3-local-ui.ts' },
  { id: 'F4', file: 'phase-f4-remote-ui.ts' },
]

function runScenario(file: string): number {
  const res = spawnSync(
    'pnpm',
    ['--filter', 'orchestrator', 'exec', 'tsx', path.join(__dirname, file)],
    {
      cwd: path.resolve(__dirname, '../../..'),
      env: process.env,
      encoding: 'utf-8',
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  )
  return res.status ?? 1
}

async function main(): Promise<void> {
  console.log(`\n========================================`)
  console.log(`  Phase F sign-off — 7 scenarios`)
  console.log(`========================================\n`)

  const results: { id: string; status: number }[] = []
  for (const s of SCENARIOS) {
    console.log(`\n[runner] starting ${s.id}: ${s.file}`)
    const status = runScenario(s.file)
    console.log(`[runner] ${s.id} exit code: ${status}`)
    results.push({ id: s.id, status })
  }

  console.log(`\n========================================`)
  console.log(`  Phase F sign-off summary`)
  console.log(`========================================`)
  for (const r of results) {
    const tag = r.status === 0 ? 'PASS' : 'FAIL'
    console.log(`  ${tag}  ${r.id}  (exit ${r.status})`)
  }

  const failed = results.filter(r => r.status !== 0)
  const pass = results.filter(r => r.status === 0)
  console.log(`\n  pass: ${pass.length} / fail: ${failed.length} / total: ${results.length}`)

  if (failed.length > 0) {
    console.log(`\n  FAILURES — file observed-vs-expected per item.`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch(err => {
  console.error('runner threw:', err)
  process.exit(1)
})
