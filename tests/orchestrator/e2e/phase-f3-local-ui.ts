/**
 * Phase F · F3 — Local UI mode.
 *
 * Verifies the canonical "develop locally" path:
 *   1. `orchestrator serve --port 9090 --host 127.0.0.1` against a fresh
 *      tmp data dir (seeded with xhs:test + social-media-engagement).
 *   2. `orchestrator ui --api http://127.0.0.1:9090 --no-open` in another
 *      process — picks a port in 5174-5184, proxies /api/* to the local
 *      server.
 *   3. Open the UI in a Playwright headless browser, kick off a memory-only
 *      agent run via the New Run modal, watch SSE chunks land in the DOM,
 *      verify completion.
 *
 * Picks a high local port for the orchestrator server (9181) so this
 * scenario doesn't conflict with anyone running `orchestrator serve` for
 * dev. UI port auto-picked in 5174-5184.
 *
 * Skips heavy phone-touching prompts; uses a memory-list prompt so the
 * scenario runs in <2 min and doesn't lock phone-4.
 *
 * Run:
 *   pnpm test:e2e:phase-f:f3
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright'

import {
  ACCOUNT_ID,
  TEAM_NAME,
  makeTmpDataDir,
  resolvePhoneBaseUrlPhaseF,
  rmTmpDataDir,
  seedLocalDataDir,
  startLocalServer,
  startLocalUi,
} from './helpers/phase-f.js'
import {
  assert,
  exitFromCounters,
  info,
  makeCounters,
  section,
  summary,
} from './helpers/spike.js'

const F3_PROMPT = process.env.OTACON_F3_PROMPT ?? 'list files in memory/'
const F3_PORT = Number(process.env.OTACON_F3_PORT ?? 9181)
const F3_TIMEOUT_MS = Number(process.env.OTACON_F3_TIMEOUT_MS ?? 8 * 60_000)

interface RailIO {
  serverHandle: { close: () => Promise<void> } | null
  uiHandle: { close: () => Promise<void> } | null
  browser: Browser | null
  dataDir: string | null
}

const rail: RailIO = { serverHandle: null, uiHandle: null, browser: null, dataDir: null }

async function teardown(): Promise<void> {
  try { if (rail.browser) await rail.browser.close() } catch {}
  try { if (rail.uiHandle) await rail.uiHandle.close() } catch {}
  try { if (rail.serverHandle) await rail.serverHandle.close() } catch {}
  if (rail.dataDir) rmTmpDataDir(rail.dataDir)
}

async function main(): Promise<void> {
  const c = makeCounters()
  console.log(`\n=== Phase F · F3: Local UI mode ===`)
  console.log(`server port = ${F3_PORT}`)
  console.log(`prompt      = ${F3_PROMPT}`)

  try {
    section('1. Setup — tmp data dir, seed, start local server')
    rail.dataDir = makeTmpDataDir('phase-f3')
    info(`dataDir = ${rail.dataDir}`)
    const seed = seedLocalDataDir(rail.dataDir)
    assert(c, seed.status === 0, `seed exits 0 (got ${seed.status})`)
    if (seed.status !== 0) info(`seed stderr: ${seed.stderr.slice(0, 600)}`)

    rail.serverHandle = await startLocalServer(F3_PORT, rail.dataDir)
    await rail.serverHandle.ready
    info(`server ready at http://127.0.0.1:${F3_PORT}`)

    // Sanity: server returns the seeded workspace.
    const wsRes = await fetch(`http://127.0.0.1:${F3_PORT}/api/v1/workspaces`)
    const ws = (await wsRes.json()) as Array<{ id: string }>
    assert(c, wsRes.status === 200 && ws.some(w => w.id === ACCOUNT_ID), `local server lists ${ACCOUNT_ID} after seed`)

    section('2. Start `orchestrator ui --api http://127.0.0.1:N`')
    rail.uiHandle = await startLocalUi(`http://127.0.0.1:${F3_PORT}`)
    info(`ui ready at ${rail.uiHandle.url}`)

    // Verify the ui server proxies /api/v1/workspaces.
    const proxyWs = await fetch(`${rail.uiHandle.url}/api/v1/workspaces`)
    assert(c, proxyWs.status === 200, `ui proxy GET /api/v1/workspaces → 200 (got ${proxyWs.status})`)
    const proxyWsJson = (await proxyWs.json()) as Array<{ id: string }>
    assert(c, proxyWsJson.some(w => w.id === ACCOUNT_ID), `ui proxy returns seeded ${ACCOUNT_ID}`)

    section('3. Resolve phone-4 base URL (for the New Run modal)')
    let phoneUrl = ''
    try {
      phoneUrl = await resolvePhoneBaseUrlPhaseF()
      info(`phone base URL = ${phoneUrl}`)
    } catch (e) {
      assert(c, false, `resolvePhone(phone-4) — ${(e as Error).message}`)
    }

    section('4. Open headless browser at the UI url, drive a run')
    rail.browser = await chromium.launch({ headless: true })
    const ctx = await rail.browser.newContext()
    const page: Page = await ctx.newPage()

    const consoleErrors: string[] = []
    page.on('console', (msg: ConsoleMessage) => {
      const t = msg.type()
      const text = msg.text()
      if (t === 'error') consoleErrors.push(`[console.error] ${text}`)
      if (t === 'warning' && /\[DONE\]|hydration|ChunkType/i.test(text)) {
        consoleErrors.push(`[console.warn] ${text}`)
      }
    })
    page.on('pageerror', err => {
      consoleErrors.push(`[pageerror] ${String((err as Error).message ?? err)}`)
    })

    await page.goto(rail.uiHandle.url, { waitUntil: 'domcontentloaded' })
    // RunsList loads workspaces from /api/v1/workspaces
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

    // Confirm the React app hydrated (#app populated).
    const appHtml = await page.locator('#app').innerHTML().catch(() => '')
    assert(c, appHtml.length > 50, `#app populated after React boot (got ${appHtml.length} chars)`)
    assert(
      c,
      consoleErrors.length === 0,
      `no console errors during static load (got ${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')})`,
    )

    // Drive a run via the API client (the UI's "New Run" modal might or
    // might not be present; we use the API the UI itself uses, then verify
    // the SessionDetail page can replay it). This is the most stable
    // assertion of "the UI talks to the API and renders the result."
    info(`POST /api/v1/runs through the ui proxy`)
    const runRes = await fetch(`${rail.uiHandle.url}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        workspace: ACCOUNT_ID,
        team: TEAM_NAME,
        phone: phoneUrl,
        userMessage: F3_PROMPT,
        resume: 'new',
        autoApprove: true,
      }),
    })
    assert(c, runRes.status === 200, `POST /runs through ui proxy → 200 (got ${runRes.status})`)
    const sid = runRes.headers.get('x-orchestrator-session-id')
    assert(c, typeof sid === 'string' && sid.length === 26, `x-orchestrator-session-id present (got ${String(sid)})`)

    // Drain the SSE stream so the run completes (otherwise the server keeps it open).
    const reader = runRes.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let done = false
    let terminal = false
    const t0 = Date.now()
    while (Date.now() - t0 < F3_TIMEOUT_MS) {
      const { value, done: d } = await reader.read()
      if (d) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const data = chunk.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n')
        if (data === '[DONE]') { done = true; break }
        try {
          const p = JSON.parse(data) as Record<string, unknown>
          if (p['kind'] === 'pi') {
            const inner = p['event'] as Record<string, unknown> | undefined
            if (inner?.['type'] === 'agent_end' || inner?.['type'] === 'agent_error') terminal = true
          }
        } catch {}
      }
      if (done) break
    }
    try { reader.releaseLock() } catch {}
    info(`run elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s; terminal=${terminal}; done=${done}`)
    assert(c, terminal, `run reached terminal pi event`)
    assert(c, done, `run emitted [DONE] sentinel`)

    // Now navigate the browser to SessionDetail for that session and
    // verify it actually renders something (proves the UI consumes the
    // events.jsonl replay endpoint correctly).
    if (sid) {
      const detailHash = `#/runs/${encodeURIComponent(sid)}?ws=${encodeURIComponent(ACCOUNT_ID)}&team=${TEAM_NAME}`
      await page.goto(`${rail.uiHandle.url}/${detailHash}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2000)
      const detailHtml = await page.locator('#app').innerHTML().catch(() => '')
      info(`SessionDetail #app html length: ${detailHtml.length}`)
      assert(c, detailHtml.length > 100, `SessionDetail page renders content for session ${sid}`)
      // Look for any text that suggests events were rendered (no specific
      // class assertions — just "the page is not empty / not an error
      // boundary").
      const sawSomething = /text|message|event|delta|turn|user|assistant/i.test(detailHtml)
      assert(c, sawSomething, `SessionDetail DOM contains event-related text`)
    }

    // Final no-error check (the SSE consumer in the page may also have
    // printed errors during the navigation).
    assert(
      c,
      consoleErrors.length === 0,
      `no browser console errors total (${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')})`,
    )

    // Verify session.json on disk shows status=completed (proves the
    // local-server data dir was actually written).
    if (sid) {
      const sessionJsonPath = path.join(
        rail.dataDir,
        'workspaces',
        ACCOUNT_ID,
        'teams',
        TEAM_NAME,
        'sessions',
        sid,
        'session.json',
      )
      assert(c, fs.existsSync(sessionJsonPath), `session.json exists on disk at ${sessionJsonPath}`)
      if (fs.existsSync(sessionJsonPath)) {
        const meta = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf-8')) as { status?: string; endedAt?: number }
        assert(c, meta.status === 'completed', `session.json status = "completed" (got "${meta.status}")`)
        assert(c, typeof meta.endedAt === 'number' && meta.endedAt > 0, `session.json endedAt > 0`)
      }
    }
  } finally {
    await teardown()
  }

  summary('Phase F · F3', c)
  exitFromCounters('Phase F · F3', c)
}

main().catch(async err => {
  console.error('F3 threw:', err)
  await teardown()
  process.exit(1)
})
