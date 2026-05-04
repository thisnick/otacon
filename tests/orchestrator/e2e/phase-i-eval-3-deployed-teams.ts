/**
 * Phase I · I-Eval-3 — Deployed VPS teams lifecycle.
 *
 * Drives the teams UI flow against the live VPS:
 *   - List shows the seeded `social-media-engagement` team
 *   - Create new throwaway team `i-eval-3-team` via dialog
 *   - Verify side-effect on disk: SSH + `ls /data/orchestrator/teams/`
 *   - Add an agent + edit prompt + verify PUT persists on disk
 *   - Force-delete the team via Danger Zone
 *   - Verify side-effect on disk: team dir gone, seeded team survives
 *
 * Run: `pnpm test:e2e:phase-i:eval:3`
 */
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright'

import { VPS_API_BASE, api, ssh } from './helpers/phase-f.js'
import {
  assert,
  exitFromCounters,
  info,
  makeCounters,
  section,
  summary,
} from './helpers/spike.js'

interface RailIO {
  browser: Browser | null
}
const rail: RailIO = { browser: null }
const NEW_TEAM = 'i-eval-3-team'
const NEW_AGENT_ROLE = 'i-eval-3-researcher'
const NEW_PROMPT = '# i-eval-3-researcher\n\nGather facts and stay neutral.\n'

async function teardown(): Promise<void> {
  try { if (rail.browser) await rail.browser.close() } catch { /* ignore */ }
  // Defensive: ensure throwaway team is gone even on assertion failure
  // mid-flow.
  try {
    await fetch(`${VPS_API_BASE}/api/v1/teams/${encodeURIComponent(NEW_TEAM)}?force=true`, {
      method: 'DELETE',
    })
  } catch { /* ignore */ }
}

function isIgnorableConsoleError(text: string): boolean {
  const t = text.toLowerCase()
  if (t.includes('favicon')) return true
  if (t.includes('react devtools')) return true
  if (t.includes('vite')) return true
  return false
}

async function main(): Promise<void> {
  const c = makeCounters()
  console.log(`\n=== Phase I · I-Eval-3: Deployed teams lifecycle (${VPS_API_BASE}) ===`)

  try {
    section('1. Seeded social-media-engagement present')
    const teams = await api<Array<{ name: string }>>('/api/v1/teams')
    assert(c, teams.status === 200, `GET /teams → 200`)
    assert(
      c,
      Array.isArray(teams.body) && teams.body.some(t => t.name === 'social-media-engagement'),
      `seeded social-media-engagement present`,
    )

    section('2. Pre-clean: ensure throwaway team doesn\'t exist from a prior run')
    await fetch(`${VPS_API_BASE}/api/v1/teams/${encodeURIComponent(NEW_TEAM)}?force=true`, {
      method: 'DELETE',
    })

    section('3. Open Teams page in browser')
    rail.browser = await chromium.launch({ headless: true })
    const ctx = await rail.browser.newContext()
    const page: Page = await ctx.newPage()

    const consoleErrors: string[] = []
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error' && !isIgnorableConsoleError(msg.text())) {
        consoleErrors.push(`[console.error] ${msg.text()}`)
      }
    })
    page.on('pageerror', err => {
      consoleErrors.push(`[pageerror] ${String((err as Error).message ?? err)}`)
    })

    await page.goto(`${VPS_API_BASE}/#/teams`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    await page.waitForSelector('[data-testid="teams-table"]', { timeout: 10_000 })
    const seededRow = await page
      .locator('[data-testid="team-row-social-media-engagement"]')
      .count()
    assert(c, seededRow === 1, `seeded team row visible in table`)

    section('4. Create new team via dialog')
    await page.locator('[data-testid="create-team-button"]').click()
    await page.waitForTimeout(300)
    await page.locator('[data-testid="team-name"]').fill(NEW_TEAM)
    await page.locator('[data-testid="team-description"]').fill('I-Eval-3 throwaway team')
    await page.locator('[data-testid="team-submit"]').click()
    await page.waitForFunction(
      (name) => window.location.hash.includes(`/teams/${name}`),
      NEW_TEAM,
      { timeout: 10_000 },
    )
    info(`navigated to team detail`)

    section('5. Server side-effect: GET /teams/:name → 200')
    const created = await api<{ name: string; agents: Array<{ role: string }> }>(
      `/api/v1/teams/${encodeURIComponent(NEW_TEAM)}`,
    )
    assert(c, created.status === 200, `GET created team → 200`)
    assert(c, created.body.name === NEW_TEAM, `name matches`)
    assert(c, created.body.agents.length === 0, `new team starts with 0 agents`)

    section('6. Disk side-effect: team dir present on VPS')
    const dirCheck = ssh(`sudo docker exec otacon-orchestrator ls /data/orchestrator/teams/ 2>&1`)
    assert(
      c,
      dirCheck.status === 0 && dirCheck.stdout.includes(NEW_TEAM),
      `${NEW_TEAM} dir exists in container's /data/orchestrator/teams/`,
    )

    section('7. Add agent via Agents tab + edit prompt')
    await page.locator('[data-testid="tab-agents"]').click()
    await page.waitForTimeout(400)
    await page.locator('[data-testid="add-agent-button"]').click()
    await page.waitForTimeout(300)
    await page.locator('[data-testid="add-agent-role"]').fill(NEW_AGENT_ROLE)
    await page.locator('[data-testid="add-agent-model"]').fill('anthropic/claude-sonnet-4.6')
    await page.locator('[data-testid="confirm-dialog-confirm"]').click()
    await page.waitForTimeout(800)

    const teamAfterAdd = await api<{ agents: Array<{ role: string }> }>(
      `/api/v1/teams/${encodeURIComponent(NEW_TEAM)}`,
    )
    assert(c, teamAfterAdd.body.agents.length === 1, `team has 1 agent`)
    assert(c, teamAfterAdd.body.agents[0]?.role === NEW_AGENT_ROLE, `role on disk = ${NEW_AGENT_ROLE}`)

    // Edit the prompt.
    const promptArea = page.locator(`[data-testid="agent-prompt-${NEW_AGENT_ROLE}"]`)
    await page.waitForTimeout(400)
    await promptArea.fill(NEW_PROMPT)
    await page.locator(`[data-testid="agent-save-${NEW_AGENT_ROLE}"]`).click()
    await page.waitForTimeout(800)

    const promptFetch = await fetch(
      `${VPS_API_BASE}/api/v1/teams/${encodeURIComponent(NEW_TEAM)}/prompts/${encodeURIComponent(NEW_AGENT_ROLE)}`,
    )
    const promptText = await promptFetch.text()
    assert(c, promptFetch.status === 200, `GET prompt → 200`)
    assert(c, promptText === NEW_PROMPT, `prompt persisted on disk`)

    section('8. Force-delete the team via Danger Zone')
    await page.locator('[data-testid="tab-settings"]').click()
    await page.waitForTimeout(300)
    await page.locator('[data-testid="team-force-delete-button"]').click()
    await page.waitForTimeout(300)
    await page.locator('[data-testid="confirm-dialog-input"]').fill(NEW_TEAM)
    await page.locator('[data-testid="confirm-dialog-confirm"]').click()
    await page.waitForFunction(() => window.location.hash === '#/teams', undefined, {
      timeout: 10_000,
    })
    info(`navigated back to list`)

    section('9. Server side-effect: team gone, seeded team survives')
    const finalList = await api<Array<{ name: string }>>('/api/v1/teams')
    assert(
      c,
      Array.isArray(finalList.body) && !finalList.body.some(t => t.name === NEW_TEAM),
      `${NEW_TEAM} no longer in /teams list`,
    )
    assert(
      c,
      Array.isArray(finalList.body) && finalList.body.some(t => t.name === 'social-media-engagement'),
      `seeded team survives`,
    )

    section('10. Disk side-effect: team dir gone, seeded team dir survives')
    const dirAfter = ssh(`sudo docker exec otacon-orchestrator ls /data/orchestrator/teams/ 2>&1`)
    assert(
      c,
      dirAfter.status === 0 && !dirAfter.stdout.includes(NEW_TEAM),
      `${NEW_TEAM} dir removed from container's /data/orchestrator/teams/`,
    )
    assert(
      c,
      dirAfter.stdout.includes('social-media-engagement'),
      `social-media-engagement dir survives`,
    )

    section('11. Console error budget')
    info(`console errors captured: ${consoleErrors.length}`)
    for (const e of consoleErrors.slice(0, 8)) info(`  ${e}`)
    assert(c, consoleErrors.length === 0, `zero non-ignorable console errors`)
  } finally {
    await teardown()
  }

  summary('Phase I · I-Eval-3', c)
  exitFromCounters('Phase I · I-Eval-3', c)
}

main().catch(async err => {
  console.error('I-Eval-3 threw:', err)
  await teardown()
  process.exit(1)
})
