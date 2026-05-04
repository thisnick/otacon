/**
 * Phase I · I-UI5 — Teams lifecycle.
 *
 * list → create (dialog) → detail → add agent → edit + save prompt → remove agent → delete team.
 *
 * Plan §6.4 Teams + Team detail (Settings + Agents tabs).
 *
 * Run: `pnpm test:e2e:phase-i:ui:5`
 */
import {
  api,
  assertNoConsoleErrors,
  bootUi,
  visit,
} from './helpers/phase-i-ui.js'
import {
  assert,
  exitFromCounters,
  info,
  makeCounters,
  section,
  summary,
} from './helpers/spike.js'

interface Team {
  name: string
  description: string
  expectedWorkspaceKind: string
  lead: string
  agents: Array<{ role: string; model: string; promptFile: string }>
}

const NEW_TEAM = 'i-ui5-team'
const NEW_AGENT_ROLE = 'researcher'
const NEW_PROMPT = '# researcher\n\nGather facts and stay neutral.\n'

async function main(): Promise<void> {
  const c = makeCounters()
  console.log('\n=== Phase I · I-UI5: Teams lifecycle ===')
  const ui = await bootUi({ seed: true })
  info(`server: ${ui.server.baseUrl}`)
  try {
    section('1. Teams list — seeded social-media-engagement is present')
    await visit(ui.page, ui.server.baseUrl, '#/teams')
    await ui.page.waitForSelector('[data-testid="teams-table"]', { timeout: 5_000 })
    const seededRow = await ui.page.locator('[data-testid="team-row-social-media-engagement"]').count()
    assert(c, seededRow === 1, `seeded team row visible`)

    section('2. Create new team via dialog')
    await ui.page.locator('[data-testid="create-team-button"]').click()
    await ui.page.waitForTimeout(200)
    await ui.page.locator('[data-testid="team-name"]').fill(NEW_TEAM)
    await ui.page.locator('[data-testid="team-description"]').fill('I-UI5 throwaway team')
    await ui.page.locator('[data-testid="team-submit"]').click()
    await ui.page.waitForFunction(
      (name) => window.location.hash.includes(`/teams/${name}`),
      NEW_TEAM,
      { timeout: 5_000 },
    )
    info(`navigated to team detail`)

    section('3. Server side-effect: GET /teams returns 2 teams')
    const teams = await api<Team[]>(ui.server.baseUrl, '/api/v1/teams')
    assert(c, teams.status === 200, `GET /teams → 200`)
    assert(c, teams.body.length === 2, `2 teams (got ${teams.body.length})`)
    const created = teams.body.find((t) => t.name === NEW_TEAM)
    assert(c, !!created, `${NEW_TEAM} present in list`)
    assert(c, created!.agents.length === 0, `new team starts with 0 agents`)

    section('4. Switch to Agents tab → empty state')
    await ui.page.locator('[data-testid="tab-agents"]').click()
    await ui.page.waitForTimeout(300)
    const agentsTabHtml = await ui.page.locator('[data-testid="agents-tab"]').innerHTML()
    assert(c, agentsTabHtml.toLowerCase().includes('no agents'), `empty-state copy on Agents tab`)

    section('5. Add agent via dialog')
    await ui.page.locator('[data-testid="add-agent-button"]').click()
    await ui.page.waitForTimeout(200)
    await ui.page.locator('[data-testid="add-agent-role"]').fill(NEW_AGENT_ROLE)
    await ui.page.locator('[data-testid="add-agent-model"]').fill('anthropic/claude-sonnet-4.6')
    await ui.page.locator('[data-testid="confirm-dialog-confirm"]').click()
    await ui.page.waitForTimeout(700)

    const agentCard = await ui.page.locator(`[data-testid="agent-card-${NEW_AGENT_ROLE}"]`).count()
    assert(c, agentCard === 1, `agent card mounted for ${NEW_AGENT_ROLE}`)

    const teamAfterAdd = await api<Team>(ui.server.baseUrl, `/api/v1/teams/${NEW_TEAM}`)
    assert(c, teamAfterAdd.body.agents.length === 1, `team now has 1 agent`)
    assert(c, teamAfterAdd.body.agents[0]?.role === NEW_AGENT_ROLE, `role on disk = ${NEW_AGENT_ROLE}`)

    section('6. Edit prompt + Save')
    const promptArea = ui.page.locator(`[data-testid="agent-prompt-${NEW_AGENT_ROLE}"]`)
    // Wait for the prompt to load (initial GET is async).
    await ui.page.waitForTimeout(400)
    await promptArea.fill(NEW_PROMPT)
    await ui.page.locator(`[data-testid="agent-save-${NEW_AGENT_ROLE}"]`).click()
    await ui.page.waitForTimeout(700)

    const promptFetch = await fetch(
      `${ui.server.baseUrl}/api/v1/teams/${NEW_TEAM}/prompts/${NEW_AGENT_ROLE}`,
    )
    const promptText = await promptFetch.text()
    assert(c, promptFetch.status === 200, `GET prompt → 200`)
    assert(c, promptText === NEW_PROMPT, `prompt persisted on disk`)

    section('7. Remove agent (typed-confirm)')
    await ui.page.locator(`[data-testid="agent-remove-${NEW_AGENT_ROLE}"]`).click()
    await ui.page.waitForTimeout(200)
    await ui.page.locator('[data-testid="confirm-dialog-input"]').fill(NEW_AGENT_ROLE)
    await ui.page.locator('[data-testid="confirm-dialog-confirm"]').click()
    await ui.page.waitForTimeout(700)

    const teamAfterRemove = await api<Team>(ui.server.baseUrl, `/api/v1/teams/${NEW_TEAM}`)
    assert(c, teamAfterRemove.body.agents.length === 0, `team has 0 agents after remove`)

    section('8. Delete the team via Danger Zone (force-delete)')
    // Server requires ?force=true for team deletion regardless of session
    // count, so the plain "Delete team" button surfaces a 400 — the
    // Force-delete dialog is the correct path.
    await ui.page.locator('[data-testid="tab-settings"]').click()
    await ui.page.waitForTimeout(200)
    await ui.page.locator('[data-testid="team-force-delete-button"]').click()
    await ui.page.waitForTimeout(200)
    await ui.page.locator('[data-testid="confirm-dialog-input"]').fill(NEW_TEAM)
    await ui.page.locator('[data-testid="confirm-dialog-confirm"]').click()
    // HashRouter changes don't fire a `load` event; poll the hash instead.
    await ui.page.waitForFunction(() => window.location.hash === '#/teams', undefined, {
      timeout: 5_000,
    })

    const finalList = await api<Team[]>(ui.server.baseUrl, '/api/v1/teams')
    assert(c, finalList.body.length === 1, `back to 1 team (just the seeded one)`)
    assert(c, finalList.body[0]?.name === 'social-media-engagement', `seeded team survives`)

    section('9. Console error budget')
    assertNoConsoleErrors(c, ui.consoleErrors)
  } finally {
    await ui.cleanup()
  }
  summary('Phase I · I-UI5', c)
  exitFromCounters('Phase I · I-UI5', c)
}

main().catch((err) => {
  console.error('I-UI5 threw:', err)
  process.exit(1)
})
