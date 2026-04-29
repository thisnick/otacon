/**
 * `POST /api/v1/runs` — start a lead-agent run.
 *
 * Body: `{ account: string, team?: string, prompt?: string }`
 * Returns: `{ runId, workflowRunId }`
 *
 * Defaults:
 *   - `team` defaults to "social-media-engagement"
 *   - `prompt` is optional; the workflow uses a generic continuation
 *      nudge if absent
 *
 * The route:
 *   1. Resolves team config + agent role via TeamStore.
 *   2. Renders the system prompt (FS-backed) and snapshots it to
 *      `runs/{runId}/prompt.md`.
 *   3. Creates a RunStore record (assigns a ULID for our `runId`).
 *   4. Calls `start(leadAgentWorkflow, [...])` — workflow ID returned
 *      here is the Workflow SDK's `wrun_*` ULID, NOT our `runId`.
 *   5. Patches the RunStore record with the `workflowRunId` and updates
 *      status → "running".
 */
import { defineEventHandler, readBody, createError } from 'h3'
import { start } from 'workflow/api'
import { ulid } from 'ulid'
import { makeStores } from '../../../../src/storage/factory.js'
import { buildSystemPromptFs } from '../../../../src/agents/build-prompt-fs.js'
import { leadAgentWorkflow } from '../../../../workflows/lead-agent.js'

interface StartRunBody {
  account?: string
  team?: string
  prompt?: string
}

const DEFAULT_TEAM = 'social-media-engagement'

export default defineEventHandler(async (event) => {
  const body = await readBody<StartRunBody>(event)
  if (!body?.account) {
    throw createError({ statusCode: 400, statusMessage: 'body.account required' })
  }

  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? '.orchestrator-data'
  const stores = await makeStores({ dataDir })

  const teamName = body.team ?? DEFAULT_TEAM
  const team = await stores.teamStore.get(teamName)
  if (!team) {
    throw createError({
      statusCode: 400,
      statusMessage: `team "${teamName}" not seeded — run \`pnpm orchestrator service seed-team --name ${teamName}\` first`,
    })
  }
  const agentRole = team.lead
  const leadAgent = team.agents.find(a => a.role === agentRole)
  if (!leadAgent) {
    throw createError({
      statusCode: 500,
      statusMessage: `team "${teamName}" config has no lead agent matching role "${agentRole}"`,
    })
  }

  const account = await stores.accountStore.get(body.account)
  if (!account) {
    throw createError({
      statusCode: 400,
      statusMessage: `account "${body.account}" not found — run \`pnpm orchestrator service add-account --id ${body.account} ...\` first`,
    })
  }

  // Render + snapshot the system prompt.
  const systemPrompt = await buildSystemPromptFs({
    teamStore: stores.teamStore,
    teamName,
    agentRole,
    accountId: body.account,
  })

  // Create the RunStore record FIRST (so we have a stable runId for the
  // workflow args). The workflow body uses runId for hook tokens.
  const runId = ulid()
  const run = await stores.runStore.create({
    id: runId,
    account: body.account,
    team: teamName,
    agentRole,
    model: leadAgent.model,
    promptTemplatePaths: [
      `teams/${teamName}/prompts/${leadAgent.promptFile}`,
      `teams/${teamName}/prompts/soul.md`,
      `teams/${teamName}/prompts/tools.md`,
    ],
    initialPrompt: body.prompt ?? null,
  })
  await stores.runStore.putPromptSnapshot(runId, systemPrompt)

  // Kick off the workflow. The arguments here are serialized into the
  // workflow event log — they need to be plain objects (no closures, no
  // references to non-serializable values).
  const wfRun = await start(leadAgentWorkflow, [{
    runId,
    accountId: body.account,
    team: teamName,
    agentRole,
    model: leadAgent.model,
    systemPrompt,
    initialPrompt: body.prompt ?? undefined,
  }])

  await stores.runStore.updateStatus(runId, 'running', { workflowRunId: wfRun.runId })

  return { runId: run.id, workflowRunId: wfRun.runId }
})
