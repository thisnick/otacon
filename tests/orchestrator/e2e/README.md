# orchestrator e2e tests

End-to-end tests for the orchestrator. Each test spawns the runtime it needs
and asserts against the resulting state. These tests are slow (multi-second
warmup) and **require process spawn + fs writes**, so they live outside the
unit suite.

## Running

From the orchestrator package:

```sh
cd src/orchestrator
pnpm test:e2e:smoke         # workflow + nitro + world-local pipeline
pnpm test                   # unit + e2e:smoke + approval-flow + failure-flow
pnpm test:e2e:phase1        # Phase 1 sign-off (requires phone-4 + XHS + LLM)
```

Or from the repo root: `pnpm test:e2e:phase1`.

Each test spawns its own server on a unique port and a fresh tmp data dir.

## Test list

| File | What it asserts | Hardware required |
|---|---|---|
| `test-workflow-smoke.ts` | Nitro builds + workflow/nitro transforms `"use workflow"`/`"use step"` + world-local persists chunks + `run.getReadable({startIndex:0})` replays them. | None — pure software. |
| `test-approval-flow.ts` | CLI ↔ server ↔ workflow ↔ approval ↔ stream replay end-to-end without DurableAgent or phone hardware. | None. |
| `test-failure-flow.ts` | Workflow failures emit `data-run-failed`, run.json reaches `failed` status. | None. |
| `phase1-xhs-scroll.ts` | **Phase 1 sign-off canonical e2e.** Bootstraps a fresh `ORCHESTRATOR_DATA_DIR`, seeds the `social-media-engagement` team, adds the `xhs:test` account, spawns Nitro, posts a run via `POST /api/v1/runs` with the prompt "Open the Xiaohongshu app (com.xingin.xhs). Scroll the home feed three times to see different content. Then exit." against phone-4, asserts run.json + prompt snapshot + workflow chunk persistence + traces + index/runs.jsonl + replay-from-startIndex-0 matches live observation. | **phone-4** reachable via `$OTACON_REGISTRY_URL` with `$OTACON_TOKEN`; Xiaohongshu (`com.xingin.xhs`) installed on phone-4; `phone_number` set in registry to match the account credential (default `+13412137456`); `$AI_GATEWAY_API_KEY`. |

## Phase 1 e2e — `phase1-xhs-scroll.ts`

Canonical scenario substituted from Chrome+search → Xiaohongshu+scroll at lead
commit `579face`: phone-4 has Xiaohongshu installed (the social-media-engagement
team's actual target app); other phones don't currently have a phone_number
set in the registry, so phone-4 is the only resolvable target.

### Prereqs

- `OTACON_REGISTRY_URL`, `OTACON_TOKEN` env vars set (or `~/.otacon/config.toml`)
- `AI_GATEWAY_API_KEY` env var set
- phone-4 connected to the registry, online, with `com.xingin.xhs` installed
- phone-4 has `phone_number=+13412137456` in the registry (matches the account's primary credential)
- (Currently) `DATABASE_URL` env var set — `service add-account` still dual-writes to Drizzle during the P1 cleanup migration. Removed at P1-I commit 10.

### Run

```sh
pnpm test:e2e:phase1                         # from repo root, or
pnpm --filter otacon-orchestrator test:e2e:phase1
```

The script spawns its own `pnpm dev` server on `PORT=9097` (override via
`PHASE1_PORT`) against a fresh `ORCHESTRATOR_DATA_DIR=$(mktemp -d ...)`. Both
are torn down on exit. Default agent timeout is 20 minutes (override via
`PHASE1_AGENT_TIMEOUT_MS`).

### Override knobs

| Env var | Default | Purpose |
|---|---|---|
| `PHASE1_PORT` | `9097` | Server port. Use a different port if you have another orch server running. |
| `PHASE1_ACCOUNT_PHONE` | `+13412137456` | Phone number registered for `xhs:test`. Must match the registry entry for phone-4 (or whichever phone you want to target). |
| `PHASE1_PROMPT` | "Open the Xiaohongshu app (com.xingin.xhs). Scroll the home feed three times to see different content. Then exit." | Initial prompt for the agent. |
| `PHASE1_AGENT_TIMEOUT_MS` | `1200000` (20min) | Total wall-clock budget for the agent loop. |

### Cleanup contract

The test owns its tmp data dir and server child process — both torn down in
`finally` even on test failure. No registry-side fixtures are created (the
account lives in the tmp data dir, not the registry).

## Authoring guidelines

- Each test spawns + tears down its own server. Use a unique `PORT` env var
  per test file (e.g. 9095, 9096, ...) so tests can run in parallel later.
- Use `fs.mkdtempSync(...)` for `ORCHESTRATOR_DATA_DIR` so the test starts
  from a clean slate. Tear it down in `finally`.
- Print PASS/FAIL one-liners and exit non-zero on any failure. The evaluator
  CI runner just checks exit code + final summary line.
- Don't depend on the order of tests. Each file is self-contained.
