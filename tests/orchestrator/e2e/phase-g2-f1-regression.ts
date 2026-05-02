/**
 * Phase G · G2 — F1 regression (API smoke against deployed VPS).
 *
 * Re-runs `phase-f1-api-smoke.ts` verbatim against the redeployed VPS.
 * Phase G mounted a static handler on the API server but did NOT change
 * any `/api/*` route — F1's 45 assertions should all still pass.
 *
 * If F1 regresses, Phase G touched something it shouldn't have. The
 * implementer reads F1's output the same way they did during Phase F.
 *
 * This script is a thin wrapper that invokes F1 as a child process,
 * surfaces its stdout/stderr verbatim, and exits with F1's exit code.
 *
 * Run:
 *   pnpm test:e2e:phase-g:g2
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

console.log(`\n=== Phase G · G2: F1 regression (re-running phase-f1-api-smoke.ts) ===`)

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
console.log(`\n=== Phase G · G2 — F1 wrapper exit ${code} ===`)
process.exit(code)
