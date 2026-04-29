/**
 * `service seed-team --name <team>` — copy an in-tree team definition into
 * the runtime data dir.
 *
 * Source layout (in-tree, what the developer edits):
 *   src/orchestrator/src/teams/{name}/
 *     config.ts            — exports a TeamConfig
 *     {promptFile}.md      — referenced by config.agents[].promptFile
 *     soul.md, tools.md    — auxiliary prompt fragments
 *
 * Destination layout (runtime, what the orchestrator reads at run time):
 *   ${ORCHESTRATOR_DATA_DIR}/teams/{name}/
 *     team.json            — JSON-serialized TeamConfig
 *     prompts/
 *       {promptFile}.md
 *       soul.md
 *       tools.md
 *
 * Idempotent: re-running over an existing seeded team simply overwrites the
 * files — no destructive cleanup, no history. The source-of-truth flow is:
 * edit the in-tree files, run `service seed-team --name <team>`. The runtime
 * never reaches into `src/teams/`.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TeamStoreFs } from '../storage/team-store.js'
import { makePaths, teamDir } from '../storage/paths.js'
import type { TeamConfig } from '../storage/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** Resolve the in-tree team source directory for a given team name. */
function inTreeTeamDir(name: string): string {
  return path.resolve(__dirname, '..', 'teams', name)
}

export async function seedTeamCommand(opts: {
  name: string
  dataDir?: string
}): Promise<void> {
  const { name } = opts
  const dataDir = opts.dataDir ?? process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'

  const srcDir = inTreeTeamDir(name)
  // Verify source exists. The dynamic import below will throw with a much
  // less actionable error if the directory is missing.
  try {
    await fs.access(srcDir)
  } catch {
    throw new Error(
      `team "${name}" not found at ${srcDir} — make sure you typed the name correctly. ` +
        `Available in-tree teams live under src/orchestrator/src/teams/.`,
    )
  }

  // Load the in-tree config module via dynamic import. The file is .ts —
  // tsx (the orchestrator's runtime) handles the transpile.
  const configPath = path.join(srcDir, 'config.ts')
  const mod = await import(configPath) as Record<string, TeamConfig | undefined>

  // The exported symbol is the camelCase version of the team name. We don't
  // know which one the developer chose, so just take whatever TeamConfig
  // shape we can find.
  const config = Object.values(mod).find(v => isTeamConfig(v)) as TeamConfig | undefined
  if (!config) {
    throw new Error(`no TeamConfig export found in ${configPath}`)
  }
  if (config.name !== name) {
    throw new Error(
      `config.ts in src/orchestrator/src/teams/${name}/ exports team "${config.name}" — ` +
        `expected "${name}" (rename the directory or fix the config).`,
    )
  }

  // Write the runtime team.json + prompts/.
  const layout = makePaths(dataDir)
  const destDir = teamDir(layout, name)
  const promptsDir = path.join(destDir, 'prompts')
  await fs.mkdir(promptsDir, { recursive: true })

  const teamJsonPath = path.join(destDir, 'team.json')
  await fs.writeFile(teamJsonPath, JSON.stringify(config, null, 2), 'utf-8')

  // Copy every .md file from the source dir into prompts/. We copy
  // everything, not just files referenced by `config.agents[].promptFile`,
  // because soul.md / tools.md / etc. are conventionally included by the
  // prompt builder and don't need an explicit reference.
  const entries = await fs.readdir(srcDir, { withFileTypes: true })
  const copied: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.md')) continue
    const srcFile = path.join(srcDir, entry.name)
    const dstFile = path.join(promptsDir, entry.name)
    const content = await fs.readFile(srcFile, 'utf-8')
    await fs.writeFile(dstFile, content, 'utf-8')
    copied.push(entry.name)
  }

  // Re-validate by reading via the store — catches malformed JSON early.
  const store = new TeamStoreFs(layout)
  const fetched = await store.get(name)
  if (!fetched) throw new Error(`seed-team wrote files but TeamStore can't read them at ${destDir}`)

  console.log(`Seeded team "${name}" into ${destDir}`)
  console.log(`  team.json      ${config.agents.length} agent(s), lead=${config.lead}`)
  console.log(`  prompts/       ${copied.length} markdown file(s): ${copied.join(', ')}`)
}

function isTeamConfig(v: unknown): v is TeamConfig {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.name === 'string' && typeof o.lead === 'string' && Array.isArray(o.agents)
}
