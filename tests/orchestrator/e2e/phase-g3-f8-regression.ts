/**
 * Phase G · G3 — F8 regression (canonical XHS canary against deployed VPS).
 *
 * Re-runs `phase-f8-phone4-canonical.ts` verbatim against the redeployed
 * VPS. Phase G doesn't touch any agent / Pi-event / sharp / trace code,
 * so F8's full P5 false-pass guards (turnCount > 0, finalText non-empty,
 * status=completed, ≥1 phone_action with all 3 trace screenshots, sha256
 * differs between annotated and before, no sharp errors in docker logs)
 * should all still hold.
 *
 * Hardware: phone-4 + XHS canonical. Single-resource lock — must NOT run
 * in parallel with anything else that touches phone-4. Long-running
 * (~3-8 min). Use `screen -dmS phase-g-g3` if invoking from a terminal
 * that may close.
 *
 * Run:
 *   pnpm test:e2e:phase-g:g3
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

console.log(`\n=== Phase G · G3: F8 regression (re-running phase-f8-phone4-canonical.ts) ===`)

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
console.log(`\n=== Phase G · G3 — F8 wrapper exit ${code} ===`)
process.exit(code)
