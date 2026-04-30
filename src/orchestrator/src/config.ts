/**
 * Orchestrator client + server config — URL the CLI talks to + bearer
 * token (reserved, no-op enforcement until Phase 5).
 *
 * Resolution order (first hit wins):
 *   1. `ORCHESTRATOR_URL` / `ORCHESTRATOR_TOKEN` env vars
 *   2. `~/.otacon/orchestrator.toml` keys `url` / `token`
 *   3. Hardcoded fallback (`http://localhost:3000`, no token)
 *
 * The token is stored + carried through but isn't enforced yet — the
 * server's `auth-stub` Nitro plugin reads it for visibility (logs presence
 * to debug, sets `event.context.authToken` for downstream handlers) but
 * doesn't reject any request based on it. Phase 5 deploy flips a single
 * env flag (`ORCHESTRATOR_AUTH_REQUIRED=1`) to enforce.
 *
 * The TOML format is intentionally minimal — same shape as the otacon
 * CLI's `~/.otacon/config.toml` so users can keep both clients in one
 * directory:
 *
 *   # ~/.otacon/orchestrator.toml
 *   url = "https://orchestrator.example.com"
 *   token = "otc_orch_..."
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export interface OrchestratorConfig {
  /** Base URL the CLI talks to. Trailing slash stripped. */
  url: string
  /** Bearer token (reserved; not enforced until Phase 5). May be undefined. */
  token: string | undefined
  /** Where the URL came from — for diagnostics + tests. */
  urlSource: 'env' | 'toml' | 'default'
  /** Where the token came from. */
  tokenSource: 'env' | 'toml' | 'none'
}

export const DEFAULT_URL = 'http://localhost:3000'

/**
 * Load the orchestrator client config. Pure resolution — no I/O beyond
 * reading the TOML file once. Safe to call from anywhere.
 *
 * @param opts.configPath override the default `~/.otacon/orchestrator.toml`
 *                        (mainly for tests)
 * @param opts.envOverride substitute env vars (mainly for tests; defaults
 *                         to `process.env`)
 */
export function loadOrchestratorConfig(opts: {
  configPath?: string
  envOverride?: NodeJS.ProcessEnv
} = {}): OrchestratorConfig {
  const env = opts.envOverride ?? process.env
  const envUrl = env.ORCHESTRATOR_URL
  const envToken = env.ORCHESTRATOR_TOKEN

  let tomlUrl: string | undefined
  let tomlToken: string | undefined
  const configPath =
    opts.configPath ??
    path.join(env.OTACON_CONFIG_DIR || path.join(os.homedir(), '.otacon'), 'orchestrator.toml')
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    tomlUrl = parseTomlString(raw, 'url')
    tomlToken = parseTomlString(raw, 'token')
  } catch {
    // Missing config is fine — fall through to env / defaults.
  }

  const rawUrl = envUrl ?? tomlUrl ?? DEFAULT_URL
  const url = rawUrl.replace(/\/$/, '')
  const urlSource: OrchestratorConfig['urlSource'] = envUrl
    ? 'env'
    : tomlUrl
      ? 'toml'
      : 'default'

  const token = envToken ?? tomlToken
  const tokenSource: OrchestratorConfig['tokenSource'] = envToken
    ? 'env'
    : tomlToken
      ? 'toml'
      : 'none'

  return { url, token, urlSource, tokenSource }
}

/**
 * Tiny TOML scalar-string reader. Handles `key = "value"` lines only —
 * we don't have nested tables or arrays in this config and pulling in a
 * full TOML parser for two keys is overkill. Same approach as
 * `src/resolve/phone.ts/loadOtaconConfig()` — intentional minimalism.
 */
function parseTomlString(raw: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*"([^"]*)"`, 'm')
  const m = raw.match(re)
  return m?.[1]
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
