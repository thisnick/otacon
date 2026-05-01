# otacon (Pi spike) e2e tests

Sign-off scenarios for the `pi-spike` branch's `src/otacon/` tree (Pi-based
agent runtime — see task #3 for the full design, task #4 for evaluator scope).

These scenarios verify the end-to-end behavior of the `otacon run` CLI against
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
pnpm test:e2e:spike-pi               # all 8 scenarios, in order
pnpm test:e2e:spike-pi:s1            # individual scenario
# ... pnpm test:e2e:spike-pi:s{1..8}
```

Each scenario uses a fresh `.otacon-data/` rooted in a per-scenario tmp dir
(env: `OTACON_DATA_DIR`). The bootstrap step seeds the `xhs:test` workspace
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
