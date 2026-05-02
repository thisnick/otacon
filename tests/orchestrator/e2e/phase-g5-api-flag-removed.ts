/**
 * Phase G · G5 — `--api` flag is gone (regression check).
 *
 * Phase G stripped the remote-control `--api` flag from `orchestrator ui`.
 * The CLI is now a local-only convenience launcher. This scenario verifies
 * that:
 *
 *   `pnpm orchestrator ui --api https://example.com`
 *
 * does NOT silently succeed. Acceptable behavior:
 *   - non-zero exit code (commander's "unknown option" default) — expected
 *   - OR a clear error/deprecation message in stderr/stdout
 *   - OR both
 *
 * Unacceptable: the process happily starts up listening on a port and
 * sends `/api/*` to https://example.com. That would be a regression.
 *
 * Run:
 *   pnpm test:e2e:phase-g:g5
 */
import { tryLocalUiWithApi } from './helpers/phase-g.js'
import {
  assert,
  exitFromCounters,
  info,
  makeCounters,
  section,
  summary,
} from './helpers/spike.js'

const G5_API_ARG = process.env.OTACON_G5_API_ARG ?? 'https://example.com'

async function main(): Promise<void> {
  const c = makeCounters()
  console.log(`\n=== Phase G · G5: 'orchestrator ui --api ${G5_API_ARG}' must NOT silently succeed ===`)

  section('1. Spawn `orchestrator ui --api ...` and observe exit')
  const r = await tryLocalUiWithApi(G5_API_ARG)
  info(`exit code  = ${r.exitCode}`)
  info(`stdout (first 400 chars):\n${r.stdout.slice(0, 400)}`)
  info(`stderr (first 400 chars):\n${r.stderr.slice(0, 400)}`)

  section('2. Assert non-acceptance')
  assert(
    c,
    r.rejected,
    `--api flag rejected (exit !=0 OR clear error message — got exitCode=${r.exitCode})`,
  )

  // Stricter sub-assertion: if commander rejected the unknown option, exit
  // is non-zero AND stderr contains the option text. This is informational
  // (won't fail G5 on its own as long as `rejected` was true), but it
  // documents which path the CLI took.
  const errLikeText = /\berror\b|unknown option|unrecognized|invalid option|no such option|deprecat/i
  const matchedSomething =
    errLikeText.test(r.stderr) || errLikeText.test(r.stdout)
  info(`error-like text in output: ${matchedSomething}`)
  if (r.exitCode !== 0) info(`(commander's unknown-option exit path)`)

  // Belt-and-braces: the CLI must NOT have been kept alive by an
  // accidental "accept and proceed" path. `tryLocalUiWithApi` will have
  // forced a kill after 8s if it didn't exit; that scenario sets
  // exitCode = -1 and rejected = false. Re-assert.
  assert(
    c,
    r.exitCode !== -1,
    `process actually exited (didn't have to be SIGTERM'd after timeout)`,
  )

  summary('Phase G · G5', c)
  exitFromCounters('Phase G · G5', c)
}

main().catch(err => {
  console.error('G5 threw:', err)
  process.exit(1)
})
