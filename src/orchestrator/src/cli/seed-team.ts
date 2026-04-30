/**
 * `service seed-team --name <team>` — copy an in-tree team template into
 * the runtime data dir.
 *
 * Source layout (in-tree, what the developer edits):
 *   src/orchestrator/templates/teams/{name}/
 *     team.json            — TeamConfig as JSON
 *     prompts/
 *       {promptFile}.md
 *       soul.md, tools.md  — auxiliary fragments
 *
 * Destination layout (runtime, what the orchestrator reads):
 *   ${ORCHESTRATOR_DATA_DIR}/teams/{name}/
 *     team.json
 *     prompts/{file}
 *
 * Idempotent: re-running overwrites the files. Source-of-truth flow:
 * edit the in-tree files, run seed-team. The runtime never reaches into
 * `templates/`.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TeamStoreFs } from '../storage/team-store.js'
import { makePaths, teamDir } from '../storage/paths.js'
import type { TeamConfig } from '../storage/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function templateTeamDir(name: string): string {
  return path.resolve(__dirname, '..', '..', 'templates', 'teams', name)
}

export async function seedTeamCommand(opts: {
  name: string
  dataDir?: string
}): Promise<void> {
  const { name } = opts
  const dataDir = opts.dataDir ?? process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'

  const srcDir = templateTeamDir(name)
  try {
    await fs.access(srcDir)
  } catch {
    throw new Error(
      `team "${name}" not found at ${srcDir} — make sure you typed the name correctly. ` +
        `Available in-tree teams live under src/orchestrator/templates/teams/.`,
    )
  }

  const teamJsonPath = path.join(srcDir, 'team.json')
  let teamJsonRaw: string
  try {
    teamJsonRaw = await fs.readFile(teamJsonPath, 'utf-8')
  } catch {
    throw new Error(`team "${name}" template missing team.json at ${teamJsonPath}`)
  }
  const config = JSON.parse(teamJsonRaw) as TeamConfig
  if (!isTeamConfig(config)) {
    throw new Error(`team.json at ${teamJsonPath} is not a valid TeamConfig`)
  }
  if (config.name !== name) {
    throw new Error(
      `template at templates/teams/${name}/team.json declares name="${config.name}" — ` +
        `expected "${name}" (rename the directory or fix the template).`,
    )
  }

  const layout = makePaths(dataDir)
  const destDir = teamDir(layout, name)
  const promptsDir = path.join(destDir, 'prompts')
  await fs.mkdir(promptsDir, { recursive: true })

  await fs.writeFile(path.join(destDir, 'team.json'), JSON.stringify(config, null, 2), 'utf-8')

  const srcPromptsDir = path.join(srcDir, 'prompts')
  let promptEntries: import('node:fs').Dirent[] = []
  try {
    promptEntries = await fs.readdir(srcPromptsDir, { withFileTypes: true })
  } catch (e: unknown) {
    const err = e as { code?: string }
    if (err?.code !== 'ENOENT') throw e
  }
  const copied: string[] = []
  for (const entry of promptEntries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.md')) continue
    const content = await fs.readFile(path.join(srcPromptsDir, entry.name), 'utf-8')
    await fs.writeFile(path.join(promptsDir, entry.name), content, 'utf-8')
    copied.push(entry.name)
  }

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
