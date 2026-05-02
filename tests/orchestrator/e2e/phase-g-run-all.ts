/**
 * Phase G sign-off runner.
 *
 * Ordering rationale:
 *   G2 (F1 regression — fast, no hardware)
 *   G1 (deployed-UI browser — fast, no hardware)
 *   G5 (--api flag rejected — fast, no hardware)
 *   G4 (local UI no-flag — local server + browser, no hardware)
 *   G3 (F8 regression — phone-4 + ~3-8 min, last)
 *
 * G3 last so the fast scenarios fail-fast if Phase G broke something
 * fundamental. Each scenario is its own child process.
 *
 * Run:
 *   pnpm test:e2e:phase-g
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SCENARIOS = [
  { id: 'G2', file: 'phase-g2-f1-regression.ts' },
  { id: 'G1', file: 'phase-g1-deployed-ui-browser.ts' },
  { id: 'G5', file: 'phase-g5-api-flag-removed.ts' },
  { id: 'G4', file: 'phase-g4-local-ui-no-flag.ts' },
  { id: 'G3', file: 'phase-g3-f8-regression.ts' },
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
  console.log(`  Phase G sign-off — 5 scenarios`)
  console.log(`========================================\n`)

  const results: { id: string; status: number }[] = []
  for (const s of SCENARIOS) {
    console.log(`\n[runner] starting ${s.id}: ${s.file}`)
    const status = runScenario(s.file)
    console.log(`[runner] ${s.id} exit code: ${status}`)
    results.push({ id: s.id, status })
  }

  console.log(`\n========================================`)
  console.log(`  Phase G sign-off summary`)
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
