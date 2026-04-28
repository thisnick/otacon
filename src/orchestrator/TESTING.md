# Orchestrator Test Suite

## Prerequisites

1. **Neon DB** provisioned with schema migrated (`pnpm orchestrator db:migrate`)
2. **`.env`** in `src/orchestrator/` with `DATABASE_URL`, `AI_GATEWAY_API_KEY`
3. **`~/.otacon/config.toml`** with `registry_url` and `token` (or set `OTACON_REGISTRY_URL` + `OTACON_TOKEN` env vars)
4. **Phone connected** — phone-4 (phone-11031jec) reachable via host at `otacon-pi`
5. **Account seeded** — `pnpm orchestrator add-account --id xhs:test --phone-number +13412137456`
6. **Registry phone_number set** — phone-4 must have `phone_number` in the registry (see note below)

## Running tests

All commands run from `src/orchestrator/`:

### test-blob-storage.ts — LocalBlobStore unit tests

```
npx tsx tests/test-blob-storage.ts
```

No external dependencies. Tests write/read/list/delete/exists, binary buffers, path traversal protection, sub-stores, and overwrite behavior. **19 tests.**

### test-conversation.ts — Conversation persistence unit tests

```
npx tsx tests/test-conversation.ts
```

No external dependencies. Tests save/load round-trip, empty conversations, message ordering (15 msgs), append-on-resume, tool call message serialization, and file numbering format. **16 tests.**

### test-sandbox-commands.ts — Sandbox command integration tests

```
npx tsx tests/test-sandbox-commands.ts
```

**Requires phone-4 reachable.** Unit tests for `isMutating()` (18 tests), then integration tests that run each otacon command through the sandbox against the real phone API: screenshot, snapshot (text + JSON), info (text + JSON), apps, notifications, clipboard, contacts, call status, record status, sms threads, tap (coords + ref), swipe (plain + duration), key (HOME + BACK), scroll (down + up), unknown command, no args. **59 tests.**

### test-e2e.ts — Full orchestrator E2E pipeline

```
npx tsx tests/test-e2e.ts
```

**Requires phone-4, Neon DB, AI gateway, `xhs:test` account seeded, and `tests/auto-approve.sh`.** Spawns the orchestrator as a subprocess and exercises: team loading, blob writes via sandbox, conversation persistence across runs, durable sleep, approval flow (with auto-approver), and kill/resume resilience. **26 tests.**

## Manual E2E run

```
pnpm orchestrator run --account xhs:test --team social-media-engagement --prompt "Take a snapshot and describe what you see"
```

Mutating actions require approval — approve interactively at the terminal prompt, or run the auto-approver in another terminal:

```
bash tests/auto-approve.sh src/orchestrator/.orchestrator/approvals
```

## Artifacts

| Artifact | Location |
|---|---|
| Blob data (screenshots, workspace files) | `src/orchestrator/.orchestrator-data/blobs/` |
| Conversation messages | `src/orchestrator/.orchestrator-data/blobs/conversations/{id}/messages/` |
| Phase A verification report | `tests/phase-a-results.md` |
| Activity log | Neon DB, `activity_logs` table |
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
