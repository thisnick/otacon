/**
 * Unit tests for `src/orchestrator/src/config.ts`.
 *
 * Resolution order: env > toml > default. Token is optional. Trailing
 * slash gets stripped from URLs.
 *
 * Run: npx tsx tests/orchestrator/unit/test-config.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadOrchestratorConfig, DEFAULT_URL } from '../../../src/orchestrator/src/config.js'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) { console.log(`  PASS  ${msg}`); passed++ }
  else { console.log(`  FAIL  ${msg}`); failed++ }
}

async function main() {
  console.log('config.ts')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-config-test-'))
  const tomlPath = path.join(tmpDir, 'orchestrator.toml')
  const noToml = path.join(tmpDir, 'absent.toml')

  // 1. Default — no env, no toml
  {
    const cfg = loadOrchestratorConfig({ envOverride: {}, configPath: noToml })
    assert(cfg.url === DEFAULT_URL, `default url is ${DEFAULT_URL} (got ${cfg.url})`)
    assert(cfg.token === undefined, 'default token undefined')
    assert(cfg.urlSource === 'default', 'urlSource=default')
    assert(cfg.tokenSource === 'none', 'tokenSource=none')
  }

  // 2. TOML provides both
  {
    fs.writeFileSync(tomlPath, 'url = "https://orch.example.com/"\ntoken = "otc_orch_abc"\n')
    const cfg = loadOrchestratorConfig({ envOverride: {}, configPath: tomlPath })
    assert(cfg.url === 'https://orch.example.com', `toml url stripped trailing slash (got ${cfg.url})`)
    assert(cfg.token === 'otc_orch_abc', `toml token (got ${cfg.token})`)
    assert(cfg.urlSource === 'toml' && cfg.tokenSource === 'toml', 'both sourced from toml')
  }

  // 3. Env overrides toml
  {
    fs.writeFileSync(tomlPath, 'url = "https://toml.example.com"\ntoken = "from-toml"\n')
    const cfg = loadOrchestratorConfig({
      envOverride: { ORCHESTRATOR_URL: 'https://env.example.com', ORCHESTRATOR_TOKEN: 'from-env' },
      configPath: tomlPath,
    })
    assert(cfg.url === 'https://env.example.com', 'env URL wins over toml')
    assert(cfg.token === 'from-env', 'env token wins over toml')
    assert(cfg.urlSource === 'env' && cfg.tokenSource === 'env', 'both env-sourced')
  }

  // 4. Mix — env URL only, toml token
  {
    fs.writeFileSync(tomlPath, 'url = "https://toml.example.com"\ntoken = "toml-token"\n')
    const cfg = loadOrchestratorConfig({
      envOverride: { ORCHESTRATOR_URL: 'https://env.example.com' },
      configPath: tomlPath,
    })
    assert(cfg.url === 'https://env.example.com', 'env URL wins')
    assert(cfg.token === 'toml-token', 'toml token used when env absent')
    assert(cfg.urlSource === 'env' && cfg.tokenSource === 'toml', 'mixed sources')
  }

  // 5. Token absent everywhere
  {
    fs.writeFileSync(tomlPath, 'url = "https://only-url.example.com"\n')
    const cfg = loadOrchestratorConfig({ envOverride: {}, configPath: tomlPath })
    assert(cfg.url === 'https://only-url.example.com', 'url-only toml')
    assert(cfg.token === undefined, 'token undefined when absent in env+toml')
    assert(cfg.tokenSource === 'none', 'tokenSource=none')
  }

  // 6. Trailing slash stripped from env URL
  {
    const cfg = loadOrchestratorConfig({
      envOverride: { ORCHESTRATOR_URL: 'http://localhost:9999///' },
      configPath: noToml,
    })
    assert(cfg.url === 'http://localhost:9999//', 'only one trailing slash stripped')
  }

  fs.rmSync(tmpDir, { recursive: true, force: true })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
