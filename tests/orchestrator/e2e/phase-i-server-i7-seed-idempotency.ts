/**
 * Phase I · I7 — Seed idempotency.
 *
 * Coverage:
 *   - Fresh data root + first seed: writes team.yaml + prompts/lead.md.
 *   - Second seed on same data root: writes nothing (per-resource idempotent).
 *   - User edits the seeded prompt; third seed leaves the edits intact.
 *   - Workspace is NOT seeded (Phase I plan §7.4 says seed.ts no longer
 *     creates workspaces).
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assert,
  exitFromCounters,
  info,
  makeCounters,
  section,
  summary,
} from './helpers/spike.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../..')
const ORCHESTRATOR_DIR = path.resolve(REPO_ROOT, 'src/orchestrator')

function runSeed(dataRoot: string): { status: number; stdout: string; stderr: string } {
  const seedScript = path.resolve(ORCHESTRATOR_DIR, 'dist/scripts/seed.js')
  const r = spawnSync('node', [seedScript], {
    encoding: 'utf-8',
    env: { ...process.env, ORCHESTRATOR_DATA_DIR: dataRoot },
  })
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  }
}

async function main() {
  const c = makeCounters()
  console.log(`\n=== Phase I · I7: seed idempotency ===`)

  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'otacon-i7-'))
  info(`data root: ${dataRoot}`)
  try {
    section('1. First seed writes team.yaml + lead.md')
    const r1 = runSeed(dataRoot)
    assert(c, r1.status === 0, `first seed exit 0 (got ${r1.status}, stderr: ${r1.stderr})`)
    assert(c, r1.stdout.includes('wrote team.yaml'),
      `output mentions team.yaml`)
    assert(c, r1.stdout.includes('wrote prompts/lead.md'),
      `output mentions prompts/lead.md`)

    const teamYaml = path.join(dataRoot, 'teams', 'social-media-engagement', 'team.yaml')
    const leadMd = path.join(dataRoot, 'teams', 'social-media-engagement', 'prompts', 'lead.md')
    const yamlExists = await fs.access(teamYaml).then(() => true).catch(() => false)
    const leadExists = await fs.access(leadMd).then(() => true).catch(() => false)
    assert(c, yamlExists, `team.yaml exists on disk`)
    assert(c, leadExists, `prompts/lead.md exists on disk`)

    section('2. Workspace is NOT seeded (Phase I)')
    const wsRoot = path.join(dataRoot, 'workspaces')
    const hasWorkspaces = await fs.access(wsRoot).then(() => true).catch(() => false)
    if (hasWorkspaces) {
      const list = await fs.readdir(wsRoot)
      assert(c, list.length === 0, `workspaces/ is empty (got ${JSON.stringify(list)})`)
    } else {
      assert(c, true, `no workspaces/ directory created`)
    }

    section('3. Second seed is a no-op (per-resource idempotent)')
    const yamlBefore = await fs.readFile(teamYaml, 'utf8')
    const leadBefore = await fs.readFile(leadMd, 'utf8')
    const yamlMtimeBefore = (await fs.stat(teamYaml)).mtimeMs

    const r2 = runSeed(dataRoot)
    assert(c, r2.status === 0, `second seed exit 0`)
    assert(c, r2.stdout.includes('up to date') || r2.stdout.includes('nothing to do'),
      `output reports nothing-to-do (got: ${r2.stdout.slice(0, 200)})`)
    const yamlAfter = await fs.readFile(teamYaml, 'utf8')
    const leadAfter = await fs.readFile(leadMd, 'utf8')
    assert(c, yamlAfter === yamlBefore, `team.yaml content unchanged`)
    assert(c, leadAfter === leadBefore, `lead.md content unchanged`)
    const yamlMtimeAfter = (await fs.stat(teamYaml)).mtimeMs
    assert(c, yamlMtimeAfter === yamlMtimeBefore,
      `team.yaml mtime unchanged (idempotent skip — file not rewritten)`)

    section('4. User edits prompt; third seed preserves edits')
    await fs.writeFile(leadMd, '## EDITED BY USER\n\nshould survive seed\n', 'utf8')
    const editedBefore = await fs.readFile(leadMd, 'utf8')
    const r3 = runSeed(dataRoot)
    assert(c, r3.status === 0, `third seed exit 0`)
    const editedAfter = await fs.readFile(leadMd, 'utf8')
    assert(c, editedAfter === editedBefore,
      `user edits to prompts/lead.md preserved (per-resource skip)`)

  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true })
  }

  summary('Phase I · I7', c)
  exitFromCounters('Phase I · I7', c)
}

main().catch(err => {
  console.error('I7 threw:', err)
  process.exit(1)
})
