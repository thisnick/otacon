/**
 * Phase I · I-Eval-5 — Phase F · F1 regression against deployed VPS,
 * with the Phase I migration applied.
 *
 * F1 is the API smoke that drives a memory-only POST /api/v1/runs against
 * the live VPS and verifies SSE delivery + error envelope shapes. F1 was
 * already updated in Phase I to drop the `phone` field from the request
 * body (the helper accepts but ignores it; the server resolves the phone
 * from `xhs:test.phoneNumber`).
 *
 * If F1 regresses on `phase-i`, the migration is incomplete. This wrapper
 * surfaces F1's exit code unchanged. Replaces Phase G's G2 for this phase.
 *
 * Run: `pnpm test:e2e:phase-i:eval:5`
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

console.log(`\n=== Phase I · I-Eval-5: F1 regression (re-running phase-f1-api-smoke.ts) ===`)

const f1Path = path.resolve(__dirname, 'phase-f1-api-smoke.ts')
const repoRoot = path.resolve(__dirname, '../../..')

const res = spawnSync(
  'pnpm',
  ['--filter', 'orchestrator', 'exec', 'tsx', f1Path],
  {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'inherit', 'inherit'],
  },
)
const code = res.status ?? 1
console.log(`\n=== Phase I · I-Eval-5 — F1 wrapper exit ${code} ===`)
process.exit(code)
