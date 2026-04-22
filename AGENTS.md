# AGENTS.md

Guidance for AI agents and humans working on the otacon codebase. Living doc — update as architectural decisions get made.

## Architecture invariants

These principles are load-bearing. Don't violate them without an explicit ADR.

### Host is the source of truth for fleet state

The Pi host (`src/server/`, `src/fleet_agent/`) directly observes the hardware:
phones via ADB, dongles via BlueZ/hciconfig, host metadata via Tailscale. The host
is the **only** authority on whether a phone is connected, which dongle is bound
to which phone, which SIMs are present, etc.

The **registry mirrors** this state for the admin UI and CLI to query. The
registry never originates state changes about phones or dongles — it only
receives them from hosts.

Implications:
- If host and registry disagree about phone status, **the host wins**.
- Admin operations like "delete phone from registry" are FORGET semantics —
  if the host re-reports the phone on the next reconciliation tick, it
  reappears. There is no "ban list" or way to override the host.
- Restart safety lives on the host: state files persisted in
  `/data/otacon/state/` plus an outbox in `/data/otacon/outbox/events.db`
  (see Reliable event delivery below).

### Reliable event delivery: outbox + reconciliation

State changes flow from host to registry as **events**. The delivery path is the
outbox pattern, with two non-negotiable rules:

**Rule 1 — All events are SET operations, never DELTA.**

Every event payload carries the new state, not a change to it. Replay is
harmless: applying the same event N times produces the same result as applying
it once.

Examples:
- ✓ `phone.connected { phone_id, adapter_mac, status: "connected" }`
- ✓ `dongle.bound { dongle_id, phone_id }` (always the current binding)
- ✗ `phone.task_count_incremented { delta: 1 }` (delta-style — forbidden)

**Rule 2 — Strict in-order delivery, single in-flight.**

The host's flusher sends events one at a time and waits for ACK before sending
the next. If a send fails, retry the SAME event with backoff before moving on.
This guarantees the registry sees events in the order the host produced them,
without needing sequence numbers or cursor tracking on the receiver.

**Why no cursors / dedup tracking on the registry:** with set-style events and
in-order delivery, idempotency is structural. Dedup is unnecessary because
applying twice equals applying once. Gap detection is unnecessary because the
sender hasn't sent N+1 yet if it hasn't ACKed N. Catch-up requests are
unnecessary because the `host.snapshot` event handles full-state sync.

### Snapshot for full-state sync

A single special event type, `host.snapshot`, carries the host's complete view
of its phones and dongles. The registry treats it as authoritative — anything
not in the snapshot for that host_id gets marked unreachable/offline.

Snapshot is sent in three situations:
1. First-ever startup (state files don't exist)
2. Migration from pre-outbox setup (state files don't exist but `phones.json` does)
3. On demand (manual force resync — admin tool, future)

The periodic 30s heartbeat continues to carry a snapshot too as a backstop.

### Reconciliation regenerates missed events

If the host crashes between observing a state change and writing the event to
the outbox, the event would normally be lost. The reconciler prevents this by
diffing **observed current state vs persisted state files** on each pass:

```
observed = enumerate(adb, hciconfig, BlueZ)
previous = read /data/otacon/state/{phones,dongles}.json
diff = compute(previous, observed)
for event in diff:
    outbox.enqueue(event)
write_atomic(state/phones.json + state/dongles.json, observed)
```

The state files are the "what we last knew" record. Any divergence from current
observation generates events to bring the registry into agreement.

## Tooling and conventions

### CLI commands
- Subcommand groups (all singular for consistency): `auth`, `reg`, `phone`,
  `phone esim`, `host`, `dongle`, `client`, `app`. Per-phone actions
  (`screenshot`, `snapshot`, `tap`, `sms`, `call`, `notifications`,
  `clipboard`, `contacts`, `record`, `open`, `info`, `key`, `swipe`, etc.)
  stay top-level for daily use.
- Config at `~/.otacon/config.toml`, all values overridable via `OTACON_*`
  env vars. Precedence: env > flag > file.
- Deployed binary is `otacon`; in-repo dev wrapper is `pnpm cli`.
- List/status commands default to column-aligned tables; `--json` opt-in
  for raw JSON.

### OpenAPI
- Both servers use code-first OpenAPI via `utoipa`. Spec served at
  `/api/docs/openapi.json`. CLI types generated via `openapi-typescript`
  from `docs/openapi/{host,registry}.json` — never hand-write API types.

### Auth scopes
- `otc_node_*` — host nodes, scope=Node, used for `/api/v1/hosts/*` endpoints
- `otc_admin_*` — CLI/UI clients, scope=Admin, used for `/api/v1/admin/*` endpoints
- Never grant a node token admin access; never use a manually-created admin
  token as a node token.

### Migration / deployment
- Use `make registry-deploy` and `make push` — they build, push to ghcr.io,
  and pull on the Pi. Watchtower will revert if the ghcr.io image is older
  than the running container, so always push after a code change.

## Areas to remember (non-obvious gotchas)

- **Dual ID system**: registry uses IDs like `phone-2`, host uses `phone-r5ct60sd`.
  The shared key is `adb_serial`. Resolver matches by adb_serial.
- **Built-in BT (hci0)** is allocatable as a dongle — no exclusion. Pi onboard
  BT is treated like a USB dongle.
- **Watchtower can revert containers** to the ghcr.io image if local builds
  aren't pushed. `make registry-deploy` and `make push` handle the push.
- **Admin token recovery is hard** — bootstrap token only printed once on
  first run. Generate replacements by editing `tokens.json` directly + restart
  if lost.
- **Host `address` is transport-agnostic** — populated by the host on
  identity registration as `${HOST_ID}.<tailnet domain from REGISTRY_URL>`.
  The CLI uses this directly to make per-phone HTTPS calls; no Tailscale
  binary or magic DNS lookup needed.
- **Phone `screen_state`** (from `/api/info`) tells callers if the phone
  is `unlocked`/`locked`/`asleep`/`dozing`/`dreaming`/`unknown`. Per-phone
  endpoints that depend on a foreground app (`apps/running`, etc.) wrap
  empty results with `screen_state` so callers can explain why.
- **`pnpm cli` shifts cwd to `src/cli/`** — relative file paths break.
  Use absolute paths (`$PWD/...`) when passing files to commands like
  `app install`. Doesn't affect the deployed `otacon` binary.
- **`.apkm` bundles** (APKMirror's AAB-derived format) install transparently
  via `otacon app install <file.apkm>` — server detects ZIP magic, extracts
  splits, runs `adb install-multiple`.
