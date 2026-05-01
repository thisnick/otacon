/**
 * Bootstrap script for the spike. Idempotent — safe to re-run.
 *
 * Seeds:
 *   .otacon-data/workspaces/xhs:test/workspace.json + env/persona.md + memory/.gitkeep
 *   .otacon-data/teams/social-media-engagement/team.json + prompts/lead.md
 *
 * Run with: `pnpm --filter otacon-spike seed`
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { dataRoot, workspaceEnvDir, workspaceMemoryDir } from '../src/storage/paths.js'
import { writeWorkspace } from '../src/storage/workspace.js'
import { writeTeam, writeTeamPrompt } from '../src/storage/team.js'
import type { Workspace, Team } from '../src/types.js'

const WORKSPACE_ID = 'xhs:test'
const TEAM_NAME = 'social-media-engagement'

const SEED_WORKSPACE: Workspace = {
  id: WORKSPACE_ID,
  displayName: 'XHS test account (spike)',
  kind: 'social',
  externalRef: 'xhs:nick123',
  createdAt: Date.now(),
}

const SEED_TEAM: Team = {
  name: TEAM_NAME,
  description: 'Operates a social media account for warming/engagement.',
  expectedWorkspaceKind: 'social',
  lead: 'engagement-lead',
  agents: [
    {
      role: 'engagement-lead',
      promptFile: 'lead.md',
      model: 'claude-sonnet-4-6',
    },
  ],
}

const LEAD_PROMPT = `# Engagement Lead

You operate a social media account through bash tools. You can:
- Use \`otacon\` subcommands to control a phone (tap, swipe, scroll, screenshot, info, snapshot, set-text, key, …)
- Use \`otacon-alloc provision\` to confirm phone access at the start of a session.
- Read / write files in the workspace sandbox via standard utilities (\`cat\`, \`echo\`, \`ls\`, etc.) or the \`read_file\` / \`write_file\` tools.
- Persist notes for future sessions in \`memory/\`. The workspace's \`env/\` files are read-only context.

Mutating actions on the phone (tap, swipe, set-text, etc.) require human approval at runtime — the runner gates each one. Read-only actions (info, snapshot, screenshot) run without approval.

If you get stuck, unsure, or need confirmation, call the \`escalate\` tool and wait for the human's response. Do NOT improvise around uncertainty.

When you finish a session, summarize what you did and what should be picked up next time. Persist that summary into \`memory/\` so the next session has continuity.
`

const ENV_PERSONA = `# Persona

You are operating a Xiaohongshu (XHS, 小红书) account. The persona is a 24-year-old design student in Toronto interested in Asian street fashion, vintage cameras, and hand-drip coffee. Engagement style: thoughtful, low-volume, prefers to comment on small accounts under 5k followers. Avoid clickbait reactions and never engage with explicitly political content.
`

async function main() {
  const root = dataRoot()
  await fs.mkdir(root, { recursive: true })

  await writeWorkspace(root, SEED_WORKSPACE)
  await fs.mkdir(workspaceEnvDir(root, WORKSPACE_ID), { recursive: true })
  await fs.writeFile(path.join(workspaceEnvDir(root, WORKSPACE_ID), 'persona.md'), ENV_PERSONA, 'utf8')
  await fs.mkdir(workspaceMemoryDir(root, WORKSPACE_ID), { recursive: true })
  await fs.writeFile(
    path.join(workspaceMemoryDir(root, WORKSPACE_ID), '.gitkeep'),
    '# kept so the dir lands in checkouts\n',
    'utf8',
  )
  // Deterministic resume-context-awareness marker. The evaluator's S2
  // scenario greps stdout for `INIT_SENTINEL_aXY7` after asking the agent
  // to read this file — distinguishes "agent saw prior context" from
  // cold-start. Idempotent overwrite is fine.
  await fs.writeFile(
    path.join(workspaceMemoryDir(root, WORKSPACE_ID), 'sessions.log'),
    '# session-marker\nINIT_SENTINEL_aXY7\n',
    'utf8',
  )

  await writeTeam(root, SEED_TEAM)
  await writeTeamPrompt(root, TEAM_NAME, 'lead.md', LEAD_PROMPT)

  process.stdout.write(`seeded:\n`)
  process.stdout.write(`  workspace: ${WORKSPACE_ID} → ${root}/workspaces/${WORKSPACE_ID}\n`)
  process.stdout.write(`  team:      ${TEAM_NAME} → ${root}/teams/${TEAM_NAME}\n`)
  process.stdout.write(`\n`)
  process.stdout.write(`run with:\n`)
  process.stdout.write(`  pnpm --filter otacon-spike otacon run \\\n`)
  process.stdout.write(`    --workspace ${WORKSPACE_ID} --team ${TEAM_NAME} \\\n`)
  process.stdout.write(`    --phone https://otacon-pi.tail0437b8.ts.net/phones/<localPhoneId> \\\n`)
  process.stdout.write(`    "list files in memory/"\n`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
