# Orchestrator Test Suite

## Prerequisites

1. **Neon DB** provisioned with schema migrated (`pnpm orchestrator service migrate`)
2. **`.env`** in `src/orchestrator/` with `DATABASE_URL`, `AI_GATEWAY_API_KEY`
3. **`~/.otacon/config.toml`** with `registry_url` and `token` (or set `OTACON_REGISTRY_URL` + `OTACON_TOKEN` env vars)
4. **Phone connected** — phone-4 (phone-11031jec) reachable via host at `otacon-pi`
5. **Account seeded** — `pnpm orchestrator service add-account --id xhs:test --phone-number +13412137456`
6. **Registry phone_number set** — phone-4 must have `phone_number` in the registry (see note below)

## Running tests

All commands run from `src/orchestrator/`:

### test-blob-storage.ts — LocalBlobStore unit tests

```
npx tsx tests/test-blob-storage.ts
```

No external dependencies. **19 tests.**

### test-conversation.ts — Conversation persistence unit tests

```
npx tsx tests/test-conversation.ts
```

No external dependencies. **16 tests.**

### test-allocation.ts — Phone allocation service tests (Phase A.2)

```
npx tsx tests/test-allocation.ts
```

DB-only (no phone needed). Verifies the `phone_allocations` table + `AllocationService`:
acquire, idempotent same-conversation re-acquire, mutual exclusion (PHONE_BUSY),
release semantics (the only UPDATE), expired lease auto-frees, getActive returns
latest non-expired row. Each test uses a fresh fixture conversation; cleanup runs
in `finally`.

### test-trace-capture.ts — Trace capture tests (Phase A.2)

```
npx tsx tests/test-trace-capture.ts
```

**Requires phone-4 reachable.** Verifies the CLI shared command modules
write `NNN-{verb}.{png,json}` when `OTACON_TRACE_DIR` is set, and write
nothing when it isn't. Spot-checks PNG bytes, JSON sidecar shape, sequence
increment within a directory.

### test-sandbox-commands.ts — Sandbox command integration tests (Phase A.2)

```
npx tsx tests/test-sandbox-commands.ts
```

**Requires phone-4 reachable.** Unit tests for `isMutating()` (18 tests),
plus integration tests that run each otacon command through the sandbox
against the real phone API. Phase A.2 additions:

- `NO_ALLOCATION` blocks all otacon commands until provision
- After provision: commands succeed
- After release: commands fail again
- `otacon-alloc status` reports state in JSON
- `otacon-alloc provision` is idempotent for the same conversation
- Agent never sees the phone ID in stdout/stderr (grep for forbidden identifiers)

Each non-allocation test now provisions on entry and releases on exit
via `withSandbox`.

### test-inspect.ts — Inspect commands (Phase A.2)

```
npx tsx tests/test-inspect.ts
```

DB + blob fixtures. Verifies:
- `inspect schema` lists core tables
- `inspect commands` lists otacon + otacon-alloc verbs
- `inspect conversations --account <id>` lists DB rows
- `inspect conversation <id>` generates a markdown report; image paths in
  the markdown resolve to actual PNG files on disk
- `inspect state --account <id>` reports active allocation + agents + activity
- `inspect logs --account <id>` tails activity_log

### test-cli-restructure.ts — CLI groups (Phase A.2)

```
npx tsx tests/test-cli-restructure.ts
```

Surface tests of the `service` / `agent` / `inspect` groups via `--help`.
Confirms old top-level commands (`run`, `add-account`, `status`, `logs`)
remain available with deprecation notices for one phase.

### test-playback-integration.ts — Trace → report regression (Phase A.2)

```
npx tsx tests/test-playback-integration.ts [--conversation <id>]
```

For each mutating bash tool call in a conversation's messages, asserts the
inspect-generated markdown embeds `![](../traces/<toolCallId>/<png>)` and that
the linked PNG file exists on disk under the blob root. Without `--conversation`,
targets the most recent conversation. Does NOT spawn the orchestrator — expects
a real agent run has already happened with at least one mutating verb. Pair
with a fresh `agent run` to verify the full chain (bash tool wrapper → trace
dir → blob path → report image link) on every release.

### test-e2e.ts — Full orchestrator E2E pipeline

```
npx tsx tests/test-e2e.ts
```

**Requires phone-4, Neon DB, AI gateway, `xhs:test` account seeded, and `tests/auto-approve.sh`.**

Phase A coverage: team loading, blob writes, conversation persistence across
runs, durable sleep, approval flow, kill/resume.

Phase A.2 additions:
- `testAllocationLifecycle` — runs an agent that provisions, takes a snapshot,
  then releases. Asserts the activity log contains `otacon-alloc provision`
  and `otacon-alloc release`, and that the trace dir is populated.
- `testInspectReportAfterRun` — runs `inspect conversation <id>` against
  the most recent conversation and verifies a markdown report was produced.

The orchestrator subprocess is now invoked as `agent run` (was `run`).

## Manual E2E run

```
pnpm orchestrator agent run --account xhs:test --team social-media-engagement --prompt "Take a snapshot and describe what you see"
```

Mutating actions require approval — approve interactively at the terminal prompt, or run the auto-approver in another terminal:

```
bash tests/auto-approve.sh src/orchestrator/.orchestrator/approvals
```

After the run completes, generate the conversation report:

```
pnpm orchestrator inspect conversation <conversation_id>
```

Open the resulting markdown at `.orchestrator-data/blobs/conversations/<id>/reports/<ts>.md`
in Preview, VS Code, or GitHub to see the agent's reasoning + screenshots
inline.

## Showboat artifact

Phase A.2 sign-off lives at `tests/phase-a2-results.md`. It is built
incrementally as the implementer ships, mirroring the structure of
`tests/phase-a-results.md`. Use `tests/showboat.sh` for standardized
markdown sections.

## Artifacts

| Artifact | Location |
|---|---|
| Blob data (screenshots, workspace files) | `src/orchestrator/.orchestrator-data/blobs/` |
| Conversation messages | `src/orchestrator/.orchestrator-data/blobs/conversations/{id}/messages/` |
| Conversation traces | `src/orchestrator/.orchestrator-data/blobs/conversations/{id}/traces/{tooluse_id}/` |
| Conversation reports | `src/orchestrator/.orchestrator-data/blobs/conversations/{id}/reports/<ts>.md` |
| Phase A verification report | `tests/phase-a-results.md` |
| Phase A.2 verification report | `tests/phase-a2-results.md` |
| Activity log | Neon DB, `activity_logs` table |
| Phone allocations | Neon DB, `phone_allocations` table |
| Auto-approve script | `tests/auto-approve.sh` |

## Registry phone_number note

The `resolvePhone()` function looks up phones by `phone_number` in the registry. The heartbeat/snapshot ingestion path creates phones with `phone_number=null`. If phone-4's number is missing from the registry, re-register it via the node token:

```
curl -X POST http://otacon-registry.tail0437b8.ts.net:9080/api/v1/hosts/phones/register \
  -H "Authorization: Bearer <node_token>" \
  -H "Content-Type: application/json" \
  -d '{"host_id":"otacon-pi","adb_serial":"11031JEC202780","phone_number":"+13412137456","model":"Pixel 4a"}'
```

The node token is stored at `/data/otacon/auth.json` inside the `otacon-otacon-1` container on the Pi.
