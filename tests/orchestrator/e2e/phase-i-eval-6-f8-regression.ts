/**
 * Phase I · I-Eval-6 — Phase F · F8 regression against deployed VPS.
 *
 * F8 is the canonical XHS run with hardware (phone-4 + Xiaohongshu). It
 * exercises the full agent loop, sharp annotation pipeline, and trace PNG
 * serving against the deployed VPS. The F8 helper passes a `phone` field
 * for back-compat which the server now ignores (workspace.phoneNumber
 * resolution is the canonical path post Phase I).
 *
 * If F8 regresses on `phase-i`, the run-time phone resolution is broken
 * and Phase I changed something it shouldn't have. This wrapper surfaces
 * F8's exit code unchanged. Replaces Phase G's G3 for this phase.
 *
 * Single phone-4 lock — must NOT run in parallel with I-Eval-4 (also XHS).
 *
 * Run: `pnpm test:e2e:phase-i:eval:6`
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

console.log(`\n=== Phase I · I-Eval-6: F8 regression (re-running phase-f8-phone4-canonical.ts) ===`)

const f8Path = path.resolve(__dirname, 'phase-f8-phone4-canonical.ts')
const repoRoot = path.resolve(__dirname, '../../..')

const res = spawnSync(
  'pnpm',
  ['--filter', 'orchestrator', 'exec', 'tsx', f8Path],
  {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'inherit', 'inherit'],
  },
)
const code = res.status ?? 1
console.log(`\n=== Phase I · I-Eval-6 — F8 wrapper exit ${code} ===`)
process.exit(code)
