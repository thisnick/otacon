# orchestrator e2e tests

Sign-off scenarios for the `src/orchestrator/` server (Pi-based agent runtime,
post-Phase-H). The orchestrator is a Hono HTTP API + same-origin web UI; there
is no longer a CLI driving runs locally. All tests target either the deployed
VPS or a locally-spawned server process via HTTP.

Scripts spawn child processes, assert observable behavior, print PASS/FAIL
one-liners, and exit non-zero on failure.

## Phase F — VPS canary sign-off

Phase F scenarios target the **deployed VPS** (default
`https://otacon-orchestrator.tail0437b8.ts.net`, override via
`$ORCHESTRATOR_API_URL`). They are the production-parity checks that gate
main-merge.

### Prereqs

1. **Deployed orchestrator** — `make orchestrator-deploy` succeeded; the VPS
   is reachable via Tailscale at `https://otacon-orchestrator.tail0437b8.ts.net/`
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
4. **Phone-4 + XHS** — registered in the registry under `+13412137456`, XHS
   app installed. `$OTACON_TOKEN` and `$OTACON_REGISTRY_URL` (or
   `~/.otacon/config.toml`) populated for the resolver.
   `$AI_GATEWAY_API_KEY` for the model.

### Run

```sh
pnpm test:e2e:phase-f                    # all 5 scenarios, in dependency order
pnpm test:e2e:phase-f:f1                 # individual scenario
# ... pnpm test:e2e:phase-f:f{1,5,6,7,8}
```

Runner ordering: F1 → F8 → F7 → F6 → F5. F8 must finish before F7 (F7 reads
F8's persisted traces). All hardware-touching scenarios (F1-light, F5, F6, F8)
are serialized — phone-4 is a single resource.

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
| F1 | `phase-f1-api-smoke.ts` | All API endpoints respond per spec; error envelope `{error: {code, message, details?}}` shape on ≥7 4xx cases. Drives a memory-only agent run via POST /api/v1/runs against the VPS, consumes SSE, asserts P5 false-pass guards (turnCount > 0, finalText non-empty, expected outer + inner chunk types). | phone-4 (resolver only). |
| F5 | `phase-f5-approval-from-ui.ts` | F5a: drives a mutating XHS prompt with no auto-approve; intercepts `escalation_requested`, POSTs `/api/v1/escalations/<token>/resolve` with `decision=approve`, verifies run reaches agent_end and persisted events.jsonl has `escalation_resolved`. F5b: same but reject; verifies decision=reject persisted. | phone-4 + XHS. |
| F6 | `phase-f6-resume-by-team.ts` | r1: POST /runs with resume=new — establishes session S1. r2: POST /runs with resume=last — verifies r2's session id == S1, messages.jsonl + events.jsonl line counts grew. | phone-4 (memory-only prompts). |
| F7 | `phase-f7-trace-png-serving.ts` | Walks VPS sessions newest-first to find a mutating phone_action; verifies all 3 trace PNGs (before/annotated/after) serve 200 with `image/png` Content-Type + PNG magic bytes; asserts `sha256(annotated.png) ≠ sha256(before.png)`; asserts Cache-Control header per spec. SSH-greps `docker logs otacon-orchestrator` for sharp errors — must show zero. | none (reads existing traces). |
| F8 | `phase-f8-phone4-canonical.ts` | Drives the canonical "open xhs and scroll the home feed once, then exit" prompt against the deployed VPS via POST /api/v1/runs; asserts strict P5 false-pass guards (turnCount > 0, finalText non-empty, status=completed, ≥1 phone_action with all 3 screenshot URLs serving 200, sha256(annotated) ≠ sha256(before)); SSH-greps docker logs for sharp errors. | phone-4 + XHS. |

### Override knobs (Phase F)

| Env var | Default | Purpose |
|---|---|---|
| `ORCHESTRATOR_API_URL` | `https://otacon-orchestrator.tail0437b8.ts.net` | Override the VPS API base URL. |
| `ORCHESTRATOR_VPS_SSH` | `ubuntu@otacon-orchestrator.tail0437b8.ts.net` | Override SSH target for log-grep checks. |
| `OTACON_F1_PROMPT` | "list the files in memory/ and tell me what you see in one short sentence." | F1 light-touch prompt. |
| `OTACON_F5_APPROVE_PROMPT` / `_REJECT_PROMPT` | "open Xiaohongshu and tap the home tab once. Then exit." | F5 prompts. |
| `OTACON_F6_PROMPT_1` / `_2` | memory-only continuation prompts | F6 prompts. |
| `OTACON_F8_PROMPT` | "open Xiaohongshu (com.xingin.xhs) and scroll the home feed once, then exit. Tell me what you saw in one sentence." | F8 canonical prompt. |
| `OTACON_F8_TIMEOUT_MS` | `1500000` (25 min) | F8 hard timeout. |

## Phase G — Server-hosted UI sign-off

Phase G flipped UI hosting from CLI-side proxy to API-server-hosted same-origin
at `/`. Phase G's test surface is small because the API + agent surfaces are
unchanged — G2/G3 are F1/F8 regression re-runs.

### Prereqs

1. **Deployed orchestrator** — same as Phase F. The container's stderr should
   show `[orchestrator-server] serving web UI from
   /app/src/orchestrator/dist/web/dist`. Verify pre-test:
   ```bash
   curl https://otacon-orchestrator.tail0437b8.ts.net/ \
     | grep -c '<div id="app">'    # → 1
   ```
2. **VPS seed for G1/G2** — same as Phase F.
3. **Playwright** — `npx playwright install chromium`.
4. **Phone-4 + XHS for G3** — same as Phase F's F8.

### Run

```sh
pnpm test:e2e:phase-g                  # all 3 scenarios in order
pnpm test:e2e:phase-g:g1               # individual scenario
# ... pnpm test:e2e:phase-g:g{1,2,3}
```

Runner ordering: G2 → G1 → G3. Fast no-hardware scenarios first; G3 (phone-4,
~3-8 min) last. For G3 use `screen -dmS phase-g-g3` if the controlling
terminal may close.

### Scenario list

| # | File | What it asserts | Hardware |
|---|---|---|---|
| G1 | `phase-g1-deployed-ui-browser.ts` | Playwright opens deployed `/`, page title set, `#app` populates, RunsList renders (workspace/team ref OR empty state), every browser `/api/*` + `/traces/*` request hits VPS same-origin (no off-origin), zero non-ignorable console errors. If sessions exist, opens first session and asserts SessionDetail loads same-origin. | none |
| G2 | `phase-g2-f1-regression.ts` | Wraps `phase-f1-api-smoke.ts` and surfaces its exit code. F1's assertions should still pass; Phase G touched only the static handler, not API routes. | phone-4 (resolver only) |
| G3 | `phase-g3-f8-regression.ts` | Wraps `phase-f8-phone4-canonical.ts`. Confirms agent + sharp + trace pipeline still work end-to-end through the deployed VPS. P5 false-pass guards (turnCount > 0, finalText non-empty, status=completed, ≥1 phone_action with all 3 trace screenshots, sha256(annotated)≠sha256(before), no sharp errors in logs). | phone-4 + XHS |

### Console error policy (G1)

Strict default: any `error`-level console message OR pageerror fails the test.
Exclusions:
- favicon-related 404s
- React DevTools install prompts

Warning-level messages are NOT errors and don't fail the test.

### Override knobs (Phase G)

| Env var | Default | Purpose |
|---|---|---|
| `ORCHESTRATOR_API_URL` | `https://otacon-orchestrator.tail0437b8.ts.net` | Override the VPS API base URL (used by G1, G2, G3). |

## Phase I — Workspace + Team CRUD APIs + UI rebuild sign-off

Phase I added full CRUD over workspaces + teams (incl. nested env files,
credentials, agent prompts), dropped the `phone` field from `POST /runs`
(server resolves from `workspace.phoneNumber`), and rebuilt the web UI on
React + shadcn with sidebar nav and per-resource detail pages.

The Phase I sign-off has three buckets (per the established
implementer/evaluator protocol). The evaluator scenarios below are
**Bucket 3** — UI canary against the deployed VPS, distinct from the
implementer's local-server I-UI suite.

### Prereqs

1. **Deployed orchestrator on `phase-i`** — `make orchestrator-deploy`
   succeeded against the post-Phase-I image. Verify:
   ```bash
   curl https://otacon-orchestrator.tail0437b8.ts.net/ | grep -c '<div id="app">'    # → 1
   curl https://otacon-orchestrator.tail0437b8.ts.net/api/v1/workspaces | jq         # xhs:test present
   ```
2. **xhs:test phoneNumber migrated** — the deployed `xhs:test` workspace
   has `phoneNumber` set (Bucket 2 PATCH migration applied):
   ```bash
   curl -X PATCH https://otacon-orchestrator.tail0437b8.ts.net/api/v1/workspaces/xhs%3Atest \
     -H 'Content-Type: application/json' \
     -d '{"phoneNumber":"+13412137456"}'
   ```
3. **Playwright** — `npx playwright install chromium`.
4. **SSH access** — `ssh ubuntu@otacon-orchestrator.tail0437b8.ts.net`
   passwordless; needed for I-Eval-2 + I-Eval-3 disk-side-effect checks.
5. **Phone-4 + XHS for I-Eval-4 + I-Eval-6** — same as Phase F's F8.

### Run

```sh
pnpm test:e2e:phase-i:eval                  # all 6 scenarios
pnpm test:e2e:phase-i:eval:1                # individual scenario
# ... pnpm test:e2e:phase-i:eval:{1,2,3,4,5,6}
```

Runner ordering: I-Eval-{1,2,3,5,4,6}. Cheap UI scenarios + no-hardware
F1 regression first; phone-4-touching I-Eval-4 + I-Eval-6 last. Single
phone-4 lock — must NOT run them in parallel. For I-Eval-4 / I-Eval-6 use
`screen -dmS phase-i-eval-4` if the controlling terminal may close.

### Scenario list

| # | File | What it asserts | Hardware |
|---|---|---|---|
| I-Eval-1 | `phase-i-eval-1-deployed-sidebar.ts` | Playwright opens deployed `/`; AppSidebar renders with all 3 nav items; theme toggle adds `.dark` to `<html>` on Dark; every browser `/api/*` request hits VPS same-origin and 2xx; zero non-ignorable console errors. Replaces Phase G G1 for this phase. | none |
| I-Eval-2 | `phase-i-eval-2-deployed-workspaces.ts` | Migrated `xhs:test` shows `phoneNumber` post-Bucket-2 PATCH. Drives the create dialog → Settings PATCH → typed-confirm delete flow against deployed VPS. Verifies on-disk side effects via `docker exec ls /data/orchestrator/workspaces/`. | none |
| I-Eval-3 | `phase-i-eval-3-deployed-teams.ts` | Drives Teams list → create dialog → add agent → edit prompt PUT → force-delete via Danger Zone. Verifies `social-media-engagement` survives + new team's dir on disk via `docker exec`. | none |
| I-Eval-4 | `phase-i-eval-4-deployed-run-flow.ts` | Drives the New Run dialog (no phone field!), intercepts POST body, asserts `body.phone` absent + `body.workspace`/`body.team`/`body.userMessage` present. Then drives the canonical XHS run via SSE; full P5 false-pass guards (turnCount > 0, finalText non-empty, status=completed, expected v7 chunks, ≥1 phone_action with all 3 traces). | phone-4 + XHS |
| I-Eval-5 | `phase-i-eval-5-f1-regression.ts` | Wraps `phase-f1-api-smoke.ts` (already updated to drop `phone` field). F1 still passes against deployed VPS post Phase I migration. Replaces Phase G G2 for this phase. | phone-4 (resolver only) |
| I-Eval-6 | `phase-i-eval-6-f8-regression.ts` | Wraps `phase-f8-phone4-canonical.ts`. Confirms full agent + sharp + trace pipeline still works via workspace-resolved phone. Replaces Phase G G3 for this phase. | phone-4 + XHS |

### Console error policy (I-Eval-1, I-Eval-2, I-Eval-3, I-Eval-4)

Strict default: any `error`-level console message OR pageerror fails the test.
Exclusions:
- favicon-related 404s
- React DevTools install prompts
- vite HMR pings (production builds shouldn't emit any but kept for safety)

### Override knobs (Phase I evaluator)

| Env var | Default | Purpose |
|---|---|---|
| `ORCHESTRATOR_API_URL` | `https://otacon-orchestrator.tail0437b8.ts.net` | Override the VPS API base URL (used by all 6 I-Eval scenarios). |
| `ORCHESTRATOR_VPS_SSH` | `ubuntu@otacon-orchestrator.tail0437b8.ts.net` | Override SSH target for I-Eval-2 + I-Eval-3 disk checks. |
| `OTACON_I_EVAL_4_PROMPT` | "open Xiaohongshu (com.xingin.xhs) and scroll the home feed once, then exit. Tell me what you saw in one sentence." | I-Eval-4 canonical prompt. |
| `OTACON_I_EVAL_4_TIMEOUT_MS` | `1500000` (25 min) | I-Eval-4 hard timeout. |

## Sign-off rules

- All scenarios pass + run output captured in TaskUpdate.
- Test artifacts committed + pushed before sign-off.
- On failure: TaskUpdate observed-vs-expected + repro command + ping team-lead.
  Do NOT debug. Do NOT mark implementer's task complete.

## Local dev (non-test)

Phase H deleted the spike-era CLI launchers. For local dev, use the root
`pnpm dev` which boots both the orchestrator server (`tsx --watch`) and the
Vite UI dev server (`localhost:5173`) concurrently, with the Vite proxy
forwarding `/api/*` to the local server. This is what replaces the old
`orchestrator serve` + `orchestrator ui` workflow.
