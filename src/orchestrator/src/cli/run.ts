import type { Db } from '../db/client.js'
import { runTeam } from '../workflows/team-runner.js'

export async function runCommand(opts: {
  account: string
  team: string
  prompt?: string
  db: Db
}) {
  const { account, team, prompt, db } = opts

  console.log(`Starting team "${team}" for account "${account}"...`)
  if (prompt) console.log(`Prompt: ${prompt}`)

  await runTeam({
    accountId: account,
    teamName: team,
    prompt,
    db,
  })
}
