/**
 * Phase I UI suite runner — invokes I-UI1 through I-UI7 in series.
 *
 * Each scenario boots its own local server and browser so they're
 * independent. Total wall-clock is the sum of each (typically ~60-90s
 * total). Aborts on the first failure.
 *
 * Run: `pnpm test:e2e:phase-i:ui`
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SCENARIOS = [
  { id: 'I-UI1', file: 'phase-i-ui-1-sidebar-nav.ts' },
  { id: 'I-UI2', file: 'phase-i-ui-2-workspaces-lifecycle.ts' },
  { id: 'I-UI3', file: 'phase-i-ui-3-env-file-editor.ts' },
  { id: 'I-UI4', file: 'phase-i-ui-4-credentials.ts' },
  { id: 'I-UI5', file: 'phase-i-ui-5-teams-lifecycle.ts' },
  { id: 'I-UI6', file: 'phase-i-ui-6-run-flow.ts' },
  { id: 'I-UI7', file: 'phase-i-ui-7-phone-combobox.ts' },
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
  console.log('  Phase I UI sign-off — 7 scenarios')
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

  console.log('\n=== Phase I UI suite summary ===')
  let failed = 0
  for (const r of results) {
    console.log(`  ${r.status === 0 ? 'PASS' : 'FAIL'}  ${r.id} (exit ${r.status})`)
    if (r.status !== 0) failed++
  }
  if (failed > 0 || results.length < SCENARIOS.length) {
    console.log(`\n  ${failed} failed, ${SCENARIOS.length - results.length} not run`)
    process.exit(1)
  }
  console.log(`\n  all ${results.length} scenarios passed`)
  process.exit(0)
}

main()
