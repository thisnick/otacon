/**
 * Phase I evaluator suite runner — invokes I-Eval-1 through I-Eval-6 in
 * series against the deployed VPS.
 *
 * Order: cheap UI scenarios first (I-Eval-1, I-Eval-2, I-Eval-3), then API
 * regression (I-Eval-5, no hardware), then the two phone-4-touching runs
 * last (I-Eval-4, I-Eval-6 — serialized because phone-4 is single-resource).
 * Aborts on the first failure.
 *
 * Run: `pnpm test:e2e:phase-i:eval`
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SCENARIOS = [
  { id: 'I-Eval-1', file: 'phase-i-eval-1-deployed-sidebar.ts' },
  { id: 'I-Eval-2', file: 'phase-i-eval-2-deployed-workspaces.ts' },
  { id: 'I-Eval-3', file: 'phase-i-eval-3-deployed-teams.ts' },
  { id: 'I-Eval-5', file: 'phase-i-eval-5-f1-regression.ts' },
  { id: 'I-Eval-4', file: 'phase-i-eval-4-deployed-run-flow.ts' },
  { id: 'I-Eval-6', file: 'phase-i-eval-6-f8-regression.ts' },
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

function main(): void {
  console.log('\n========================================')
  console.log('  Phase I evaluator sign-off — 6 scenarios')
  console.log('========================================\n')

  const results: { id: string; status: number }[] = []
  for (const s of SCENARIOS) {
    console.log(`\n[runner] starting ${s.id}: ${s.file}`)
    const status = runScenario(s.file)
    results.push({ id: s.id, status })
    if (status !== 0) {
      console.log(`[runner] ${s.id} FAILED (exit ${status}); aborting`)
      break
    }
  }

  console.log('\n=== Phase I evaluator suite summary ===')
  let failed = 0
  for (const r of results) {
    console.log(`  ${r.status === 0 ? 'PASS' : 'FAIL'}  ${r.id} (exit ${r.status})`)
    if (r.status !== 0) failed++
  }
  console.log(`\n  pass: ${results.length - failed} / fail: ${failed} / total: ${results.length}`)
  process.exit(failed === 0 && results.length === SCENARIOS.length ? 0 : 1)
}

main()
