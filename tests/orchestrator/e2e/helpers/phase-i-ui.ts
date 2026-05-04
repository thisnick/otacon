/**
 * Shared scaffolding for Phase I UI e2e scenarios (I-UI1 — I-UI7).
 *
 * Each scenario boots a fresh local orchestrator server (via the
 * server-side helper), opens a Playwright browser at its same-origin UI,
 * and asserts surface behaviour through `data-testid` selectors authored
 * in `src/orchestrator/web/`.
 *
 * The browser is configured to fail on any uncaught console error or
 * pageerror (with a small allow-list for favicon 404s + React DevTools
 * noise that mirrors Phase G1's policy).
 *
 * Run a single scenario: `pnpm test:e2e:phase-i:ui:1` (or the script
 * registered in the workspace root package.json).
 */
import {
  chromium,
  type Browser,
  type ConsoleMessage,
  type Page,
} from 'playwright'

import { bootLocalServer, api, type LocalServer } from './phase-i.js'
import { type AssertCounters } from './spike.js'

export type { LocalServer }

/** Same allow-list rules as Phase G's deployed UI smoke. */
export function isIgnorableConsoleError(text: string): boolean {
  const t = text.toLowerCase()
  if (t.includes('favicon')) return true
  if (t.includes('react devtools')) return true
  // The vite dev server ships HMR pings — not present in production builds
  // (which is what the orchestrator serves), but keep the rule for safety.
  if (t.includes('vite')) return true
  return false
}

export interface UiHandles {
  server: LocalServer
  browser: Browser
  page: Page
  consoleErrors: string[]
  /** Reset the captured console errors between assertions. */
  resetErrors: () => void
  cleanup: () => Promise<void>
}

export interface UiBootOpts {
  /** Pass-through to bootLocalServer; default `seed: true`. */
  seed?: boolean
  /** Verbose server logs. */
  verbose?: boolean
}

export async function bootUi(opts: UiBootOpts = {}): Promise<UiHandles> {
  const server = await bootLocalServer({ seed: opts.seed ?? true, verbose: opts.verbose })
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const consoleErrors: string[] = []
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error' && !isIgnorableConsoleError(msg.text())) {
      consoleErrors.push(`[console.error] ${msg.text()}`)
    }
  })
  page.on('pageerror', (err) => {
    consoleErrors.push(`[pageerror] ${String(err.message ?? err)}`)
  })
  const cleanup = async (): Promise<void> => {
    try { await browser.close() } catch { /* ignore */ }
    try { await server.stop() } catch { /* ignore */ }
  }
  return {
    server,
    browser,
    page,
    consoleErrors,
    resetErrors: () => { consoleErrors.length = 0 },
    cleanup,
  }
}

/** Helpful sentry: every scenario should end by checking this. */
export function assertNoConsoleErrors(c: AssertCounters, errs: string[]): void {
  if (errs.length === 0) {
    console.log(`  PASS  zero console errors`)
    c.passed++
  } else {
    console.log(`  FAIL  ${errs.length} console error(s):`)
    for (const e of errs.slice(0, 8)) console.log(`        ${e}`)
    c.failures.push(`console errors: ${errs.slice(0, 3).join(' | ')}`)
    c.failed++
  }
}

/** Convenience: navigate to a hash route and wait for network idle. */
export async function visit(page: Page, base: string, hash: string): Promise<void> {
  await page.goto(`${base}/${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined)
}

/** Re-export the api helper so scenarios can verify server side-effects. */
export { api }
