/**
 * Pi-spike sign-off runner — invokes all 8 scenarios in order.
 *
 * Each scenario script is run as its own child process so a failure in one
 * doesn't block the others (matches phase 3's "all scenarios run, summary at
 * end" behavior). Per-scenario failures are surfaced as observed-vs-expected
 * in the final TaskUpdate; the lead routes them.
 *
 * STATUS: SKELETON — every child currently exits 2 (skeleton flag) until the
 * implementer's #3 handoff lands and assertions are wired in.
 *
 * Run:
 *   pnpm test:e2e:spike-pi
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface ScenarioResult {
  id: string
  status: number
  stdout: string
  stderr: string
}

const SCENARIOS = [
  { id: 'S1', file: 's1-fresh-run-smoke.ts' },
  { id: 'S2', file: 's2-resume-team-default.ts' },
  { id: 'S3', file: 's3-force-new-session.ts' },
  { id: 'S4', file: 's4-approval-gate-tty.ts' },
  { id: 'S5', file: 's5-phone-action-artifacts.ts' },
  { id: 'S6', file: 's6-sandbox-acl.ts' },
  { id: 'S7', file: 's7-resume-pi-roundtrip.ts' },
  { id: 'S8', file: 's8-specific-session-resume.ts' },
]

async function runScenario(file: string): Promise<ScenarioResult> {
  // tsx lives in src/orchestrator/ workspace deps (matches phase1-5 wiring).
  // Invoke via `pnpm --filter otacon-orchestrator exec tsx ...` so we don't
  // require a root-level tsx install.
  const res = spawnSync(
    'pnpm',
    ['--filter', 'otacon-orchestrator', 'exec', 'tsx', path.join(__dirname, file)],
    {
      cwd: path.resolve(__dirname, '../../..'),
      env: process.env,
      encoding: 'utf-8',
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  )
  return {
    id: file,
    status: res.status ?? 1,
    stdout: '',
    stderr: '',
  }
}

async function main(): Promise<void> {
  console.log(`\n========================================`)
  console.log(`  Pi-spike sign-off — all 8 scenarios`)
  console.log(`========================================\n`)

  const results: { id: string; status: number }[] = []
  for (const s of SCENARIOS) {
    console.log(`\n[runner] starting ${s.id}: ${s.file}`)
    const r = await runScenario(s.file)
    console.log(`[runner] ${s.id} exit code: ${r.status}`)
    results.push({ id: s.id, status: r.status })
  }

  console.log(`\n========================================`)
  console.log(`  Pi-spike sign-off summary`)
  console.log(`========================================`)
  for (const r of results) {
    const tag =
      r.status === 0 ? 'PASS' :
      r.status === 2 ? 'SKEL' :
      'FAIL'
    console.log(`  ${tag}  ${r.id}  (exit ${r.status})`)
  }

  const failed = results.filter(r => r.status === 1)
  const skel = results.filter(r => r.status === 2)
  const pass = results.filter(r => r.status === 0)
  console.log(`\n  pass: ${pass.length} / fail: ${failed.length} / skeleton: ${skel.length} / total: ${results.length}`)

  if (failed.length > 0) {
    console.log(`\n  FAILURES — file observed-vs-expected per item in TaskUpdate.`)
    process.exit(1)
  }
  if (skel.length > 0 && process.env.OTACON_SPIKE_ALLOW_SKELETON_EXIT !== '1') {
    console.log(`\n  SKELETON — ${skel.length} scenarios still stubbed. Set OTACON_SPIKE_ALLOW_SKELETON_EXIT=1 to silence.`)
    process.exit(2)
  }
  process.exit(0)
}

main().catch(err => {
  console.error('runner threw:', err)
  process.exit(1)
})
