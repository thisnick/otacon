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
pnpm test:e2e:phase2        # Phase 2 sign-off (auto-screenshot wrapper; requires phone-4 + XHS + LLM)
pnpm test:e2e:phase3        # Phase 3 sign-off (HTTP API + SSE streaming; requires phone-4 + XHS + LLM)
```

Or from the repo root: `pnpm test:e2e:phase1` / `pnpm test:e2e:phase2` / `pnpm test:e2e:phase3`.

Each test spawns its own server on a unique port and a fresh tmp data dir.

## Test list

| File | What it asserts | Hardware required |
|---|---|---|
| `test-workflow-smoke.ts` | Nitro builds + workflow/nitro transforms `"use workflow"`/`"use step"` + world-local persists chunks + `run.getReadable({startIndex:0})` replays them. | None — pure software. |
| `test-approval-flow.ts` | CLI ↔ server ↔ workflow ↔ approval ↔ stream replay end-to-end without DurableAgent or phone hardware. | None. |
| `test-failure-flow.ts` | Workflow failures emit `data-run-failed`, run.json reaches `failed` status. | None. |
| `phase1-xhs-scroll.ts` | **Phase 1 sign-off canonical e2e.** Bootstraps a fresh `ORCHESTRATOR_DATA_DIR`, seeds the `social-media-engagement` team, adds the `xhs:test` account, spawns Nitro, posts a run via `POST /api/v1/runs` with the prompt "Open the Xiaohongshu app (com.xingin.xhs). Scroll the home feed three times to see different content. Then exit." against phone-4, asserts run.json + prompt snapshot + workflow chunk persistence + traces + index/runs.jsonl + replay-from-startIndex-0 matches live observation. | **phone-4** reachable via `$OTACON_REGISTRY_URL` with `$OTACON_TOKEN`; Xiaohongshu (`com.xingin.xhs`) installed on phone-4; `phone_number` set in registry to match the account credential (default `+13412137456`); `$AI_GATEWAY_API_KEY`. |
| `phase2-xhs-actions.ts` | **Phase 2 sign-off canonical e2e.** Drives an XHS scenario exercising tap + set-text + key + swipe, then validates: every mutating-verb tool call produced `before/after.png` (valid PNGs via `sharp` metadata) and an `annotated.png` whose perceptual hash differs ≥5 bits from `before.png`; live SSE includes a `data-phone-action` chunk per action with full payload (tool_call_id, command, subcommand, target, rationale, screenshots URL block, exit_code, stdout, stderr, started_at, completed_at); the bash `tool-call`/`tool-result` chunks coexist (additive emission); non-mutating verbs leave no PNG residue. | Same as Phase 1: phone-4 + XHS + registry + `$AI_GATEWAY_API_KEY`. |
| `phase3-streaming.ts` | **Phase 3 sign-off canonical e2e.** Three scenarios over distinct tmp data dirs: (A) **Streaming + Resumable Replay** — disconnect mid-stream, resume via `?startIndex=N`; concat of live segment + resumed segment must equal a fresh full replay-from-0 (chunk count + type sequence). (B) **Cancellation** — POST `/api/v1/runs/:id/cancel` mid-flight; terminal chunk == `data-run-cancelled`; `run.json` and GET `/api/v1/runs/:id` report `status: cancelled`. (C) **Durable approval across server restart** — kill server while workflow blocks at `data-signal-created`, respawn fresh nitro on the same data dir, POST resolve, verify run resumes from saved state and reaches `data-run-completed`. | Same as Phase 1: phone-4 + XHS + registry + `$AI_GATEWAY_API_KEY`. |

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

## Phase 2 e2e — `phase2-xhs-actions.ts`

Canonical scenario kept on the same XHS surface as Phase 1: phone-4 + the
Xiaohongshu app. The lead's task description called for Chrome on phone-3,
but per the substitution decision committed at `579face`, XHS is the actual
target app and phone-4 is the only resolvable target in the current registry
state. The test exercises the same verbs (tap + set-text + key + swipe) the
Chrome scenario would have.

### Prereqs

Same as Phase 1, plus the implementer-side wrapper at
`src/orchestrator/src/sandbox/build-fs.ts` (P2-I commit `57b2530`) wired
into `execBashStep` so screenshots and `data-phone-action` chunks are
produced during runs.

### Run

```sh
pnpm test:e2e:phase2                         # from repo root, or
pnpm --filter otacon-orchestrator test:e2e:phase2
```

Server on `PORT=9098` (override via `PHASE2_PORT`). Default agent timeout
25 minutes — the multi-verb scenario takes longer than Phase 1's pure
scroll.

### Override knobs

| Env var | Default | Purpose |
|---|---|---|
| `PHASE2_PORT` | `9098` | Server port. |
| `PHASE2_ACCOUNT_PHONE` | `+13412137456` | Phone number registered for `xhs:test` (= phone-4). |
| `PHASE2_PROMPT` | XHS multi-verb prompt | Initial prompt. |
| `PHASE2_AGENT_TIMEOUT_MS` | `1500000` (25min) | Wall-clock budget for the agent. |

### Cleanup contract

Same as Phase 1: tmp data dir + server child process torn down in `finally`.
No registry-side fixtures.

## Phase 3 e2e — `phase3-streaming.ts`

Three scenarios in one runner:

| Scenario | What it asserts | Approx. runtime |
|---|---|---|
| A. Streaming + Resumability | mid-flight `?startIndex=N` resumption equals a fresh full replay (chunk count + type sequence) | ~12-18min |
| B. Cancellation | `POST /api/v1/runs/:id/cancel` produces `data-run-cancelled` and `status=cancelled` | ~3-5min |
| C. Durable approval across server restart | kill server while workflow is suspended on a `data-signal-created` hook; fresh nitro on same data dir resumes via `POST /signals/:id/resolve`; run completes | ~10-15min |

### Prereqs

Same as Phase 1/2 (phone-4 + XHS + registry + AI gateway). Plus
`pnpm orchestrator serve` must be available on the CLI (P3-I commit).

### Run

```sh
pnpm test:e2e:phase3                         # from repo root, or
pnpm --filter otacon-orchestrator test:e2e:phase3
```

Each scenario uses a fresh `ORCHESTRATOR_DATA_DIR` and a unique port
(9101/9102/9103 by default; override via `PHASE3_PORT_A/B/C`). Default
total budget ~50min.

### Override knobs

| Env var | Default | Purpose |
|---|---|---|
| `PHASE3_PORT_A/B/C` | `9101/9102/9103` | Per-scenario server ports. |
| `PHASE3_ACCOUNT_PHONE` | `+13412137456` | Phone number registered for `xhs:test`. |
| `PHASE3_PROMPT_STREAMING` | "Open Xiaohongshu, scroll feed three times, exit." | Scenario A prompt. |
| `PHASE3_PROMPT_CANCEL` | "Open Xiaohongshu, slowly browse home feed for as long as you can." | Scenario B prompt — agent should keep going so cancel has something to interrupt. |
| `PHASE3_PROMPT_DURABLE` | "Open Xiaohongshu, tap a feed item, exit." | Scenario C prompt — short scenario; the test interrupts at first signal anyway. |
| `PHASE3_AGENT_TIMEOUT_MS` | `1500000` (25min) | Scenario A timeout. |
| `PHASE3_CANCEL_TIMEOUT_MS` | `300000` (5min) | Scenario B timeout. |
| `PHASE3_DURABLE_TIMEOUT_MS` | `1500000` (25min) | Scenario C timeout. |

### Cleanup contract

Each scenario's tmp data dir + server child process torn down in shared
`teardown()` at the end of the runner — even on partial failure across
scenarios. Server v1 in scenario C is killed mid-test (deliberate); the
runner removes it from the cleanup list to avoid double-kill.

## Authoring guidelines

- Each test spawns + tears down its own server. Use a unique `PORT` env var
  per test file (e.g. 9095, 9096, ...) so tests can run in parallel later.
- Use `fs.mkdtempSync(...)` for `ORCHESTRATOR_DATA_DIR` so the test starts
  from a clean slate. Tear it down in `finally`.
- Print PASS/FAIL one-liners and exit non-zero on any failure. The evaluator
  CI runner just checks exit code + final summary line.
- Don't depend on the order of tests. Each file is self-contained.
