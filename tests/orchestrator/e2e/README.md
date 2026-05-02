# orchestrator e2e tests

Sign-off scenarios for the `src/orchestrator/` tree (Pi-based agent runtime —
see task #3 for the full design, task #4 for evaluator scope).

These scenarios verify the end-to-end behavior of the `orchestrator run` CLI against
the canonical phone-4 + Xiaohongshu hardware setup. They mirror the phase 1-5
e2e style: each script spawns its own subprocess, asserts observable behavior,
prints PASS/FAIL one-liners, exits non-zero on failure.

## Status

**SKELETON.** All 8 scenarios are stubbed pending implementer (#3) handoff.
Each `.ts` file has the full design comment + a stubbed describe block
referencing the locked task #4 contract. Real assertions will be filled in
once the implementer signals ready and confirms exact CLI shapes, output
markers, file paths, and event-kind strings.

Set `OTACON_SPIKE_ALLOW_SKELETON_EXIT=1` to silence the skeleton-exit code 2
that each scenario currently exits with (so CI doesn't flag the stubs as
failing).

## Running

From repo root:

```sh
pnpm test:e2e:orchestrator               # all 8 scenarios, in order
pnpm test:e2e:orchestrator:s1            # individual scenario
# ... pnpm test:e2e:orchestrator:s{1..8}
```

Each scenario uses a fresh `.otacon-data/` rooted in a per-scenario tmp dir
(env: `ORCHESTRATOR_DATA_DIR`). The bootstrap step seeds the `xhs:test` workspace
and the `social-media-engagement` team. Cleanup tears down the tmp dir in
`finally` (override with `KEEP_TMP_DIR=1` for inspection).

## Scenario list

| # | File | What it asserts | Hardware |
|---|---|---|---|
| S1 | `s1-fresh-run-smoke.ts` | First-ever `otacon run` against `xhs:test` + `social-media-engagement`. Console markers (`▶ run`, `[user]`, `┌ bash$`, `└ exit`, `■ done`). Sessions dir created. messages.jsonl + events.jsonl + session.json + last-session.txt + sandbox/ symlink tree all present. | phone-4 + XHS |
| S2 | `s2-resume-team-default.ts` | Re-running the same command without `--new` continues the prior session. messages.jsonl + events.jsonl APPENDED (line counts grow). Agent demonstrates awareness of prior context. last-session.txt unchanged. | phone-4 + XHS |
| S3 | `s3-force-new-session.ts` | `--new` produces a new session id. New `sessions/{id}/` dir. last-session.txt updated. Old session files unchanged. | phone-4 + XHS |
| S4 | `s4-approval-gate-tty.ts` | A mutating bash command (`otacon tap`) triggers the TTY approval prompt. `y` allows + emits `phone_action` event. `n` blocks with synthetic-error + run continues. Approval audit event recorded. | phone-4 + XHS |
| S5 | `s5-phone-action-artifacts.ts` | After S4 approve case: `traces/{tcid}/before.png + annotated.png + after.png` exist as valid PNGs. `annotated` differs from `before` (sharp visual hash diff). events.jsonl `phone_action` paths match disk. | phone-4 + XHS |
| S6 | `s6-sandbox-acl.ts` | Agent attempting to read `credentials.json` cannot reach it from `sandbox/` cwd. Manual `cd .. && ls` from sandbox does not surface credentials. | phone-4 + XHS |
| S7 | `s7-resume-pi-roundtrip.ts` | After any session: load messages.jsonl in a small node script, call `agent.continue(messages)` via the implementer's verification entry point. No parse error. Round-trips. | none (filesystem only) |
| S8 | `s8-specific-session-resume.ts` | `--session <S1-id>` continues S1, NOT the latest. last-session.txt updated per implementer's chosen behavior (confirm at handoff). | phone-4 + XHS |

## Sign-off rules (per task #4)

- All 8 scenarios pass with assertions in committed test scripts.
- Test artifacts committed + pushed to `pi-spike` branch.
- Run output captured in TaskUpdate description per scenario.
- If any scenario fails: TaskUpdate observed-vs-expected + one-line repro
  command + SendMessage to team-lead. Do NOT mark #3 completed. Do NOT
  investigate root cause.

## Hardware / env

Same as phase1-5 e2e:
- phone-4 reachable via `$OTACON_REGISTRY_URL` with `$OTACON_TOKEN`
- XHS (`com.xingin.xhs`) installed on phone-4
- Phone has `phone_number` set in registry matching the workspace
  credential (default `+13412137456` for `xhs:test`)
- `$AI_GATEWAY_API_KEY` (or `$OPENROUTER_API_KEY` — confirm with implementer
  which provider the team config uses).

## Override knobs

| Env var | Default | Purpose |
|---|---|---|
| `OTACON_SPIKE_DATA_DIR` | `mktemp -d ...` | Override the tmp `.otacon-data` root. |
| `OTACON_SPIKE_WORKSPACE_PHONE` | `+13412137456` | Phone number registered for `xhs:test`. |
| `OTACON_SPIKE_S1_PROMPT` | "list files in memory and tell me what you see" | S1 fresh run prompt. |
| `OTACON_SPIKE_S2_PROMPT` | "what did you see last time? summarize" | S2 resume prompt. |
| `OTACON_SPIKE_S3_PROMPT` | "fresh start. list memory contents." | S3 forced-new prompt. |
| `OTACON_SPIKE_S4_PROMPT` | "open Xiaohongshu and tap the home tab" | S4 mutating prompt. |
| `OTACON_SPIKE_S6_PROMPT` | "read the credentials.json file in this workspace" | S6 ACL probe. |
| `OTACON_SPIKE_TIMEOUT_MS` | `1500000` (25 min) | Per-scenario timeout. |
| `KEEP_TMP_DIR` | unset | When set to `1`, preserves the tmp data dir on exit. |
| `OTACON_SPIKE_ALLOW_SKELETON_EXIT` | unset | When set to `1`, skeleton stubs exit 0 instead of 2. |

## Cleanup contract

Each scenario owns its tmp data dir and any subprocesses. Both torn down in
`finally` — even on test failure. No registry-side fixtures are created
(workspace lives entirely in the tmp `.otacon-data/`).

## Phase F — VPS canary sign-off

Phase F scenarios target the **deployed VPS** (default
`https://otacon-orchestrator.tail0437b8.ts.net`, override via
`$ORCHESTRATOR_API_URL`) rather than a per-scenario tmp data dir. They are
the production-parity checks that gate main-merge.

### Prereqs

1. **Deployed orchestrator** — `make orchestrator-deploy` succeeded; the
   VPS is reachable via Tailscale at `https://otacon-orchestrator.tail0437b8.ts.net/`
   and `/healthz` returns 200.
2. **Seeded data dir** — the VPS data volume has been seeded with the
   canonical `xhs:test` workspace + `social-media-engagement` team:
   ```bash
   ssh ubuntu@otacon-orchestrator.tail0437b8.ts.net 'cd /opt/orchestrator && \
     sudo docker compose exec -T otacon-orchestrator pnpm --filter orchestrator seed'
   ```
   Verify: `curl https://otacon-orchestrator.tail0437b8.ts.net/api/v1/workspaces`
   returns `[{id:"xhs:test", ...}]`.
3. **SSH access** — `ssh ubuntu@otacon-orchestrator.tail0437b8.ts.net` works
   without prompting (Tailscale ACL + key); needed for F7/F8's `docker logs`
   grep + sudo passwordless on the VPS.
4. **Playwright Chromium** — for the UI scenarios (F3, F4):
   ```bash
   pnpm install                 # picks up the playwright devDep
   npx playwright install chromium
   ```
5. **Phone-4 + XHS** — same as Phase 1-5 (registered in the registry under
   `+13412137456`, XHS app installed). `$OTACON_TOKEN` and
   `$OTACON_REGISTRY_URL` (or `~/.otacon/config.toml`) populated for the
   resolver. `$AI_GATEWAY_API_KEY` for the model.

### Run

```sh
pnpm test:e2e:phase-f                    # all 7 scenarios, in dependency order
pnpm test:e2e:phase-f:f1                 # individual scenario
# ... pnpm test:e2e:phase-f:f{1,3,4,5,6,7,8}
```

Runner ordering: F1 → F8 → F7 → F6 → F5 → F3 → F4. F8 must finish before F7
(F7 reads F8's persisted traces). All hardware-touching scenarios (F1-light,
F5, F6, F8) are serialized — phone-4 is a single resource.

For long-running scenarios (F8 ~3-8 min), prefer `screen -dmS` so the run
survives if the controlling terminal closes:

```bash
screen -dmS phase-f8 bash -c 'pnpm test:e2e:phase-f:f8 > /tmp/phase-f8.log 2>&1; \
  echo "EXIT_CODE=$?" >> /tmp/phase-f8.log'
# poll: tail -50 /tmp/phase-f8.log; screen -ls
```

### Scenario list

| # | File | What it asserts | Hardware |
|---|---|---|---|
| F1 | `phase-f1-api-smoke.ts` | All API endpoints respond per spec; error envelope `{error: {code, message, details?}}` shape on ≥7 4xx cases. Drives a memory-only agent run via POST /api/v1/runs against the VPS, consumes SSE, asserts P5 false-pass guards (turnCount > 0, finalText non-empty, expected outer + inner chunk types). Folds in the original F2 (CLI parity — see note below). | phone-4 (resolver only). |
| F3 | `phase-f3-local-ui.ts` | `orchestrator serve` locally on a tmp data dir + `orchestrator ui` proxying to it; Playwright opens the UI, drives a memory-only run via the CLI proxy, verifies React app boots without console errors and SessionDetail page renders. Asserts the local data dir's session.json reflects status=completed. | phone-4 (resolver only). |
| F4 | `phase-f4-remote-ui.ts` | `orchestrator ui --api <deployed VPS>` locally; Playwright opens the UI, verifies React app boots and proxy forwards every browser `/api/*` request through `localhost:<cli-proxy-port>` (no direct VPS calls — would CORS-block). | none. |
| F5 | `phase-f5-approval-from-ui.ts` | F5a: drives a mutating XHS prompt with no auto-approve; intercepts `escalation_requested`, POSTs `/api/v1/escalations/<token>/resolve` with `decision=approve`, verifies run reaches agent_end and persisted events.jsonl has `escalation_resolved`. F5b: same but reject; verifies decision=reject persisted. **Note**: drives via API POST instead of Playwright UI click — see Known UI bug below. | phone-4 + XHS. |
| F6 | `phase-f6-resume-by-team.ts` | r1: POST /runs with resume=new — establishes session S1. r2: POST /runs with resume=last — verifies r2's session id == S1, messages.jsonl + events.jsonl line counts grew. | phone-4 (memory-only prompts). |
| F7 | `phase-f7-trace-png-serving.ts` | Walks VPS sessions newest-first to find a mutating phone_action; verifies all 3 trace PNGs (before/annotated/after) serve 200 with `image/png` Content-Type + PNG magic bytes; asserts `sha256(annotated.png) ≠ sha256(before.png)` (proves the `30df7a8` annotation-overlay fix landed and `sharp` actually drew the overlay); asserts Cache-Control header per spec. SSH-greps `docker logs otacon-orchestrator` for sharp errors — must show zero. | none (reads existing traces). |
| F8 | `phase-f8-phone4-canonical.ts` | Drives the canonical "open xhs and scroll the home feed once, then exit" prompt against the deployed VPS via POST /api/v1/runs; asserts strict P5 false-pass guards (turnCount > 0, finalText non-empty, status=completed, ≥1 phone_action with all 3 screenshot URLs serving 200, sha256(annotated) ≠ sha256(before)); SSH-greps docker logs for sharp errors. | phone-4 + XHS. |

### Folding rationale (F2)

Task #10 originally listed 8 scenarios. F2 ("CLI parity — `orchestrator run
--api https://...`") was folded into F1 because the orchestrator CLI is
filesystem-only by design (per `docs/orchestrator-v2-plan.md` load-bearing
appendix: "CLI agent run removed; remote control is browser-only via `ui
--api`"). The CLI's `run` and `sessions list` subcommands have no `--api`
flag and the design explicitly doesn't want one. F1 verifies the same
"external client kicks off a run on the deployed VPS" semantic via direct
POST + SSE, which is the API contract that ships. `orchestrator ui --api
<deployed>` is exercised in F4.

### Known UI bug (caught by F3/F4) — blocks UI sign-off

The web app at `src/orchestrator/web/src/api-client.ts` reads
`window.__API_BASE__` (which `orchestrator ui` injects with the literal
`--api` URL value) and uses it as a literal fetch base. When the user runs
`orchestrator ui --api http://127.0.0.1:9090` (F3) or `--api
https://otacon-orchestrator.tail0437b8.ts.net` (F4), the browser then issues
fetches directly to those URLs, bypassing the local CLI proxy on
`http://localhost:5174`. The browser CORS-blocks these cross-origin
requests because the API server doesn't set `Access-Control-Allow-Origin`
(the API spec line 31 explicitly relies on the proxy doing same-origin).

Result: F3 and F4 both see "RunsList tries to load workspaces, fetch fails
with CORS, RunsList renders empty/error state." F1 (curl-based) and F8
(curl-based) work fine because they don't go through the browser. Direct
`fetch()` from the test against the local CLI proxy also works (proves the
proxy itself is fine). The bug is purely in the React API client's choice
of base URL.

Likely fix (implementer-side): either (a) `orchestrator ui` injects an
empty `__API_BASE__` so paths are same-origin to the proxy, or (b)
`api-client.ts` defaults to empty string when not explicitly set to
`window.location.origin`, or (c) the API server emits permissive CORS
headers. (c) is least desirable per the spec's "CORS not required" stance.

### Override knobs (Phase F)

| Env var | Default | Purpose |
|---|---|---|
| `ORCHESTRATOR_API_URL` | `https://otacon-orchestrator.tail0437b8.ts.net` | Override the VPS API base URL. |
| `ORCHESTRATOR_VPS_SSH` | `ubuntu@otacon-orchestrator.tail0437b8.ts.net` | Override SSH target for log-grep checks. |
| `OTACON_F1_PROMPT` | "list the files in memory/ and tell me what you see in one short sentence." | F1 light-touch prompt. |
| `OTACON_F3_PROMPT` | "list files in memory/" | F3 prompt. |
| `OTACON_F3_PORT` | `9181` | Local server port for F3. |
| `OTACON_F5_APPROVE_PROMPT` / `_REJECT_PROMPT` | "open Xiaohongshu and tap the home tab once. Then exit." | F5 prompts. |
| `OTACON_F6_PROMPT_1` / `_2` | memory-only continuation prompts | F6 prompts. |
| `OTACON_F8_PROMPT` | "open Xiaohongshu (com.xingin.xhs) and scroll the home feed once, then exit. Tell me what you saw in one sentence." | F8 canonical prompt. |
| `OTACON_F8_TIMEOUT_MS` | `1500000` (25 min) | F8 hard timeout. |
| `KEEP_TMP_DIR` | unset | When `1`, preserves F3's tmp data dir. |

## Phase G — Server-hosted UI sign-off

Phase G flipped UI hosting from "CLI hosts UI + proxies API" (Phase D/F)
to "API server hosts UI same-origin at /". The CLI `orchestrator ui` is
now a local-only convenience launcher (no `--api` flag). Phase G's
test surface is small because the API + agent surfaces are unchanged —
G2/G3 are F1/F8 regression re-runs.

### Prereqs

1. **Phase G implementer commit deployed** — `make orchestrator-deploy`
   succeeded against `pi-spike` at `2fc644a` or later. The container's
   stderr should show `[orchestrator-server] serving web UI from
   /app/src/orchestrator/dist/web/dist`. Verify pre-test:
   ```bash
   curl https://otacon-orchestrator.tail0437b8.ts.net/ \
     | grep -c '<div id="app">'    # → 1
   curl https://otacon-orchestrator.tail0437b8.ts.net/ \
     | grep -c 'Web UI not built'  # → 0 (placeholder absent)
   ```
2. **Local web bundle built** — for G4 (the local-UI scenario), the
   `src/orchestrator/web/dist/` directory must exist:
   ```bash
   pnpm --filter orchestrator-web build
   ```
3. **Seed for G4** — G4 spins up its own local server on a tmp data dir
   and seeds it via `pnpm --filter orchestrator seed:dev`. No manual
   step required.
4. **VPS seed for G1/G2** — same as Phase F (the deployed VPS volume
   carries `xhs:test` + `social-media-engagement`).
5. **Playwright** — `npx playwright install chromium` (same as Phase F).
6. **Phone-4 + XHS for G3** — same as Phase F's F8.

### Run

```sh
pnpm test:e2e:phase-g                  # all 5 scenarios in order
pnpm test:e2e:phase-g:g1               # individual scenario
# ... pnpm test:e2e:phase-g:g{1..5}
```

Runner ordering: G2 → G1 → G5 → G4 → G3. Fast no-hardware scenarios
first; G3 (phone-4, ~3-8 min) last. For G3 use `screen -dmS phase-g-g3`
if the controlling terminal may close.

### Scenario list

| # | File | What it asserts | Hardware |
|---|---|---|---|
| G1 | `phase-g1-deployed-ui-browser.ts` | Playwright opens deployed `/`, page title set, `#app` populates, RunsList renders (workspace/team ref OR empty state), every browser `/api/*` + `/traces/*` request hits VPS same-origin (no off-origin), zero non-ignorable console errors. If sessions exist, opens first session and asserts SessionDetail loads same-origin. | none |
| G2 | `phase-g2-f1-regression.ts` | Wraps `phase-f1-api-smoke.ts` and surfaces its exit code. F1's 45 assertions should all still pass; Phase G touched only the static handler, not API routes. | phone-4 (resolver only) |
| G3 | `phase-g3-f8-regression.ts` | Wraps `phase-f8-phone4-canonical.ts`. Confirms agent + sharp + trace pipeline still work end-to-end through the deployed VPS. P5 false-pass guards (turnCount > 0, finalText non-empty, status=completed, ≥1 phone_action with all 3 trace screenshots, sha256(annotated)≠sha256(before), no sharp errors in logs). | phone-4 + XHS |
| G4 | `phase-g4-local-ui-no-flag.ts` | Boots local API server on :9090 with seeded tmp data dir; spawns `pnpm orchestrator ui --no-open` (no `--api` flag); Playwright opens the printed local URL. RunsList renders, every browser `/api/*` request goes through the local UI proxy (no bypass), zero non-ignorable console errors. Tests the kept "convenience launcher for local dev" path. | none |
| G5 | `phase-g5-api-flag-removed.ts` | Spawns `pnpm orchestrator ui --api https://example.com --no-open`. Asserts the process either exits non-zero OR emits a clear error/deprecation message — must NOT silently succeed. Belt-and-braces: process must actually exit (no SIGTERM-from-timeout). | none |

### Console error policy (G1, G4)

Strict default: any `error`-level console message OR pageerror fails the
test. Exclusions (per `feedback_team_roles.md` discipline — file edge
cases as observable behavior, not silent filters):
- favicon-related 404s
- React DevTools install prompts

Warning-level messages are NOT errors and don't fail the test.

### Override knobs (Phase G)

| Env var | Default | Purpose |
|---|---|---|
| `ORCHESTRATOR_API_URL` | `https://otacon-orchestrator.tail0437b8.ts.net` | Override the VPS API base URL (used by G1, G2, G3). |
| `OTACON_G4_PORT` | `9090` | Local server port for G4. |
| `OTACON_G5_API_ARG` | `https://example.com` | The `--api` value G5 passes (it just needs to be syntactically a URL). |
| `KEEP_TMP_DIR` | unset | When `1`, preserves G4's tmp data dir. |

### Sign-off rules (Phase G)

Same as Phase F:
- All scenarios pass + run output captured in TaskUpdate
- Test artifacts committed + pushed before sign-off
- On failure: TaskUpdate observed-vs-expected + repro command + ping
  team-lead. Do NOT debug. Do NOT mark implementer's task complete.
