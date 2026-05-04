/**
 * Phase I server-side e2e runner.
 *
 * Each scenario is its own child process via `pnpm --filter orchestrator
 * exec tsx <file>` so failures in one don't pollute the next.
 *
 * Run:  pnpm test:e2e:phase-i:server
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SCENARIOS = [
  { id: 'I1', file: 'phase-i-server-i1-workspaces-crud.ts' },
  { id: 'I2', file: 'phase-i-server-i2-env-files.ts' },
  { id: 'I3', file: 'phase-i-server-i3-credentials.ts' },
  { id: 'I4', file: 'phase-i-server-i4-teams-crud.ts' },
  { id: 'I5', file: 'phase-i-server-i5-phones.ts' },
  { id: 'I6', file: 'phase-i-server-i6-run-workspace-phone.ts' },
  { id: 'I7', file: 'phase-i-server-i7-seed-idempotency.ts' },
  { id: 'I8', file: 'phase-i-server-i8-workspace-sessions.ts' },
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
  console.log(`  Phase I server e2e — ${SCENARIOS.length} scenarios`)
  console.log(`========================================\n`)

  const results: { id: string; status: number }[] = []
  for (const s of SCENARIOS) {
    console.log(`\n[runner] starting ${s.id}: ${s.file}`)
    const status = runScenario(s.file)
    console.log(`[runner] ${s.id} exit code: ${status}`)
    results.push({ id: s.id, status })
  }

  console.log(`\n========================================`)
  console.log(`  Phase I server e2e summary`)
  console.log(`========================================`)
  for (const r of results) {
    const tag = r.status === 0 ? 'PASS' : 'FAIL'
    console.log(`  ${tag}  ${r.id}  (exit ${r.status})`)
  }

  const failed = results.filter(r => r.status !== 0)
  const pass = results.filter(r => r.status === 0)
  console.log(`\n  pass: ${pass.length} / fail: ${failed.length} / total: ${results.length}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('runner threw:', err)
  process.exit(1)
})
