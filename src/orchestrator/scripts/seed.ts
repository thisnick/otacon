/**
 * Bootstrap script. Phase I rewrites this around per-resource idempotent
 * merges from the on-source seed-templates tree.
 *
 * What it seeds (per `docs/orchestrator-phase-i-plan.md` §7.4):
 *   teams/<name>/team.yaml + prompts/*.md  ← from seed-templates/teams/<name>/
 *
 * What it does NOT seed:
 *   - Workspaces (Phase I — workspaces are user-created via the UI/API)
 *   - Credentials (always platform-specific; never templated)
 *   - Per-workspace env files (those are seeded at workspace-create time)
 *
 * Idempotent: re-running is safe. Existing files are never overwritten.
 *
 * Run with: `pnpm --filter orchestrator seed` (or `seed:dev` via tsx).
 */
import * as fs from 'node:fs/promises'
import { dataRoot } from '../src/storage/paths.js'
import { listSeedTeamNames, seedDefaultTeam } from '../src/storage/team.js'

async function main() {
  const root = dataRoot()
  await fs.mkdir(root, { recursive: true })

  const teamNames = await listSeedTeamNames()
  if (teamNames.length === 0) {
    process.stdout.write(`no seed-template teams found; nothing to do\n`)
    return
  }

  process.stdout.write(`seeding into ${root}\n`)
  let totalWritten = 0
  for (const name of teamNames) {
    const written = await seedDefaultTeam(root, name)
    if (written.length === 0) {
      process.stdout.write(`  ${name}: up to date (skipped)\n`)
    } else {
      totalWritten += written.length
      for (const file of written) {
        process.stdout.write(`  ${name}: wrote ${file}\n`)
      }
    }
  }
  process.stdout.write(`\n`)
  if (totalWritten === 0) {
    process.stdout.write(`nothing to do — all seeded files already exist.\n`)
  } else {
    process.stdout.write(`wrote ${totalWritten} file(s).\n`)
  }
  process.stdout.write(`\n`)
  process.stdout.write(`workspaces are user-created via the UI or:\n`)
  process.stdout.write(`  curl -X POST http://localhost:9090/api/v1/workspaces \\\n`)
  process.stdout.write(`    -H 'content-type: application/json' \\\n`)
  process.stdout.write(`    -d '{"id":"xhs:test","displayName":"XHS test","kind":"social","phoneNumber":"+13412137456"}'\n`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
