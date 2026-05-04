# Orchestrator HTTP API

Contract between the orchestrator web server (`src/orchestrator/server/`,
implemented in Phase B) and its consumers (the web UI hosted same-origin at
`/`, and any external automation that POSTs against the API).

This is the lock-point: once committed, B and C implement against this spec
in parallel without coordinating.

## Conventions

- Base path: all routes are mounted at `/api/v1/`.
- Workspace ids may contain `:` (e.g. `xhs:test`). Encode them with
  `encodeURIComponent` in path params.
- Session ids are ULIDs (Crockford base-32, 26 chars).
- Timestamps are integer milliseconds since the Unix epoch.
- All JSON responses are UTF-8 with `Content-Type: application/json`.
- All POST/PUT bodies are JSON unless otherwise noted.
- The data-root environment variable is `ORCHESTRATOR_DATA_DIR` (default
  `.otacon-data` for backward compatibility with the spike's filesystem
  layout).

## Auth

- **Tailscale ingress only** for v1. The server is exposed via Tailscale
  Serve (`https://otacon-orchestrator.<tailnet>.ts.net/`); off-tailnet
  requests can't reach it. No bearer token check on individual routes.
- A token field exists in `~/.orchestrator/config.toml` for forward
  compatibility but is not enforced yet. The server MUST NOT reject
  requests for missing/invalid tokens in v1 — that's a follow-up.
- CORS: not required. The web UI is served same-origin from the orchestrator
  itself; the CLI proxies trace PNGs same-origin.

## Error response format

Every 4xx/5xx response shares one shape:

```json
{
  "error": {
    "code": "workspace_not_found",
    "message": "workspace \"xhs:test\" not found",
    "details": { "workspaceId": "xhs:test" }
  }
}
```

- `code` — stable machine-readable string (snake_case).
- `message` — human-readable, may include identifiers.
- `details` — optional, structure varies per code.

Common codes:

| HTTP | Code | When |
|---|---|---|
| 400 | `bad_request` | Malformed body, missing required field, invalid enum value, invalid format (E.164, workspace id pattern, etc.). |
| 400 | `phone_unresolvable` | Workspace's `phoneNumber` couldn't be resolved at run-start (registry doesn't have it, host unreachable, or workspace lacks the field). |
| 404 | `workspace_not_found` | Path `:workspace` / `:id` doesn't exist on disk. |
| 404 | `team_not_found` | Path `:team` / `:name` doesn't exist on disk. |
| 404 | `session_not_found` | Path `:sid` doesn't exist on disk. |
| 404 | `escalation_not_found` | No pending escalation for the given token. |
| 404 | `env_file_not_found` | Env file doesn't exist for that workspace. |
| 404 | `no_default_for_file` | Reset requested but no seed-default exists (e.g. user-added env file or prompt with no template). |
| 404 | `no_default_for_team` | Team reset requested but no seed-default `team.yaml` exists for that name. |
| 404 | `agent_role_not_found` | Per-agent prompt route referenced a role that isn't on the team's `agents[]`. |
| 409 | `escalation_already_resolved` | Token has already been resolved. |
| 409 | `workspace_kind_mismatch` | Team's `expectedWorkspaceKind` ≠ workspace's `kind`. |
| 409 | `workspace_already_exists` | `POST /workspaces` with an `id` that already has a `workspace.json` on disk. |
| 409 | `team_already_exists` | `POST /teams` with a `name` that already has a `team.yaml` (or legacy `team.json`) on disk. |
| 409 | `workspace_has_sessions` | `DELETE /workspaces/:id` without `?force=true` when sessions exist under any team. |
| 502 | `phones_unavailable` | `GET /phones` couldn't reach the registry (no creds, network error, or non-2xx). |
| 500 | `internal` | Anything unexpected (server bug, fs failure). |

## Routes

### `POST /api/v1/runs` — start a run

Starts (or resumes) a session against a workspace + team and streams events
back as SSE. The connection stays open until the agent reaches a terminal
state or the client disconnects.

**Request body:**

```ts
interface StartRunRequest {
  workspace: string         // workspace id (e.g. "xhs:test")
  team: string              // team name (e.g. "social-media-engagement")
  userMessage: string       // first user message for this turn
  resume?: 'last' | 'new' | string
                            // 'last' (default): resume last-session.txt
                            // 'new': force a new session id
                            // string: resume the specified session id
  autoApprove?: boolean     // bypass approval gate (default false)
  autoReject?: boolean      // always reject mutating commands (default false)
  modelProvider?: string    // override team's default provider (e.g. 'vercel-ai-gateway')
}
```

> **Phase I migration:** the `phone` field was dropped. The server now
> resolves the phone base URL from the workspace's `phoneNumber` via the
> registry. Pre-Phase-I clients that still send `phone` aren't rejected —
> the field is silently ignored. New clients should omit it.

**Response:** `200 OK` with `Content-Type: text/event-stream` and SSE body
(see [SSE event format](#sse-event-format) below). The first event is
always `{ kind: 'system_set', ... }` followed by `{ kind: 'user_message',
... }`.

The response also sets a custom header so clients can identify the session
without parsing the stream:

```
x-orchestrator-session-id: 01HXX...
```

**Terminal events** (stream ends after one of these):

- `{ kind: 'pi', event: { type: 'agent_end', ... } }` — successful completion
- `{ kind: 'pi', event: { type: 'agent_error', ... } }` — agent threw

After the terminal event, the server writes a final `data: [DONE]\n\n`
sentinel and closes the connection.

**Errors (returned as 4xx/5xx before the stream starts):**

- 400 `bad_request` — missing required field or invalid `resume` value.
- 400 `phone_unresolvable` — workspace's `phoneNumber` is unset or the registry can't resolve it to a host.
- 404 `workspace_not_found` / `team_not_found` / `session_not_found`.
- 409 `workspace_kind_mismatch`.

Once the stream is open the server commits to writing terminal events,
not HTTP errors. A mid-stream agent failure surfaces as an `agent_error`
Pi event, NOT an HTTP 500.

### `GET /api/v1/workspaces` — list workspaces

```ts
interface Workspace {
  id: string                // unique, "kind:identifier" using [a-zA-Z0-9_-] + .
  displayName: string
  kind: string              // "social" or future kinds
  phoneNumber?: string      // E.164; required on new workspaces (Phase I)
  externalRef?: string
  createdAt: number
}

// Response:
type Response = Workspace[]
```

Walks `${dataRoot}/workspaces/*/workspace.json`. Stable sort by `id` ascending.

### `POST /api/v1/workspaces` — create a workspace

**Request body:**

```ts
interface CreateWorkspaceRequest {
  id: string                // required, unique, format "kind:identifier"
  displayName: string       // required
  kind: string              // required (currently only "social")
  phoneNumber: string       // required, E.164 format (e.g. "+13412137456")
  externalRef?: string      // optional
}
```

**Response:** `201 Created` with the full `Workspace` (server fills `createdAt`).

**Side effects** at create:
1. Creates `${dataRoot}/workspaces/<id>/`
2. Writes `workspace.json`
3. Bootstraps `env/{persona,soul,memory}.md` from `seed-templates/workspaces/<kind>/`
4. Creates an empty `memory/` dir

**Errors:**
- 400 `bad_request` — missing field, invalid id pattern, invalid `phoneNumber` E.164.
- 409 `workspace_already_exists` — id collision.

### `GET /api/v1/workspaces/:id` — single workspace

Returns the `Workspace` object. 404 `workspace_not_found` if absent.

### `PATCH /api/v1/workspaces/:id` — partial update

Mutable fields: `displayName`, `kind`, `phoneNumber`, `externalRef`.
Immutable: `id`, `createdAt`. Pass `externalRef: ""` (or `null`) to
clear it.

**Response:** `200 OK` with the full updated `Workspace`.

### `DELETE /api/v1/workspaces/:id[?force=true]` — delete a workspace

- Without `?force=true`: 409 `workspace_has_sessions` if any session
  dirs exist under any team for this workspace. Otherwise 204.
- With `?force=true`: cascade-deletes the entire workspace directory
  (sessions, traces, memory, env, credentials). 204.

### Env files — `/api/v1/workspaces/:id/env`

Per-workspace markdown context the agent reads into its system prompt
at run-start. File content is plain markdown (no frontmatter). All env
files concatenated in alphabetical order.

```
GET    /api/v1/workspaces/:id/env                         → 200 EnvFileSummary[]
GET    /api/v1/workspaces/:id/env/:file                   → 200 text/markdown
PUT    /api/v1/workspaces/:id/env/:file                   → 204 (text/markdown body)
DELETE /api/v1/workspaces/:id/env/:file                   → 204
POST   /api/v1/workspaces/:id/env/:file/reset             → 200 text/markdown
```

```ts
interface EnvFileSummary {
  name: string              // e.g. "persona.md"
  size: number              // bytes
  modifiedAt: number        // ms epoch
}
```

`POST .../reset` returns 404 `no_default_for_file` if the file isn't a
seed-default for the workspace's `kind` (e.g. user-added `anything.md`).

File names must match `[a-zA-Z0-9._-]+\.md` and not start with `.`.

### Credentials — `/api/v1/workspaces/:id/credentials`

Write-only. The server stores whatever JSON the client PUTs but the
read endpoint never returns the values.

```
GET    /api/v1/workspaces/:id/credentials   → 200 {hasCredentials, fieldsSet}
PUT    /api/v1/workspaces/:id/credentials   → 204 (JSON object body)
DELETE /api/v1/workspaces/:id/credentials   → 204
```

```ts
interface CredentialsStatus {
  hasCredentials: boolean
  fieldsSet: string[]       // top-level JSON object keys (sorted)
}
```

PUT bodies must be JSON objects (not arrays / scalars).

### `GET /api/v1/workspaces/:workspace/sessions` — cross-team sessions

Returns every session under any team in this workspace's directory.
Cheaper for the UI's WorkspaceDetail "Sessions" tab than iterating teams.

```ts
type Response = SessionSummary[]
```

`SessionSummary` shape is the same as the per-team sessions endpoint
(see further down). Sort by `startedAt` descending (most recent first).

Walks `${dataRoot}/workspaces/:workspace/teams/*/sessions/*/session.json`
on disk — surfaces sessions even from teams that have been removed from
the global team catalog. Returns `[]` for a workspace with no `teams/`
directory or no sessions.

**Errors:**
- 404 `workspace_not_found`.

### `GET /api/v1/workspaces/:workspace/teams` — list compatible teams

```ts
interface Team {
  name: string
  description: string
  expectedWorkspaceKind: string
  lead: string
  agents: Array<{ role: string; model: string; promptFile: string }>
}

type Response = Team[]
```

Walks `${dataRoot}/teams/*/team.{yaml,json}` and filters to teams whose
`expectedWorkspaceKind` matches the workspace's `kind`. Sort by `name`
ascending.

(Note: `${dataRoot}/teams/` is the global team catalog; teams are not
nested under a workspace on disk. The `:workspace` path param exists so
the route surfaces only teams compatible with this workspace's kind.)

### Teams CRUD — `/api/v1/teams`

```
GET    /api/v1/teams[?workspaceKind=social]  → 200 Team[]
POST   /api/v1/teams                         → 201 Team
GET    /api/v1/teams/:name                   → 200 Team
PATCH  /api/v1/teams/:name                   → 200 Team
DELETE /api/v1/teams/:name?force=true        → 204

# Per-agent prompts (markdown):
GET    /api/v1/teams/:name/prompts/:role           → 200 text/markdown
PUT    /api/v1/teams/:name/prompts/:role           → 204 (text/markdown body)

# Reset to seed defaults:
POST   /api/v1/teams/:name/reset                   → 200 Team
POST   /api/v1/teams/:name/prompts/:role/reset     → 200 text/markdown
```

Team names + agent roles must match `/^[a-z0-9][a-z0-9-]{0,63}$/`.

`agents[].promptFile` is computed by the server (`<role>.md`) on agent
addition; clients don't set it. PATCH preserves the existing
`promptFile` for unchanged roles, ensuring seed-time filenames (e.g.
`lead.md` for the seeded `engagement-lead` role) survive PATCH.

Adding an agent via PATCH creates `prompts/<role>.md` (copying the
seed-default if one exists, else empty). Removing an agent deletes the
file.

`POST /teams/:name/reset` returns the seed-default team config and
overwrites disk. 404 `no_default_for_team` if no template exists.

`DELETE` requires `?force=true` (cascade-delete).

### `GET /api/v1/phones` — list registry phones (read-only proxy)

Proxies the orchestrator's admin token against the otacon registry,
filters to phones with a `phoneNumber`, and reshapes for the UI.

```ts
interface PhoneSummary {
  phoneNumber: string                       // E.164
  status: 'online' | 'offline' | 'unreachable'
  registryId: string                        // e.g. "phone-4"
  displayLabel: string                      // e.g. "+13412137456 — phone-4 (otacon-pi)"
  hostId: string | null
}

type Response = PhoneSummary[]
```

Sort by `phoneNumber` ascending.

**Errors:**
- 502 `phones_unavailable` — registry unreachable, missing creds, or non-2xx.

### `GET /api/v1/workspaces/:workspace/teams/:team/sessions` — list sessions

```ts
interface SessionSummary {
  id: string                // ULID
  workspace: string
  team: string
  agentRole: string
  modelProvider: string
  modelId: string
  startedAt: number
  endedAt: number | null
  status: 'running' | 'completed' | 'aborted' | 'error'
  error?: string | null
}

type Response = SessionSummary[]
```

Walks
`${dataRoot}/workspaces/:workspace/teams/:team/sessions/*/session.json`.
Sort by `startedAt` descending (most recent first).

### `GET /api/v1/workspaces/:workspace/teams/:team/sessions/:sid` — session metadata

Single `SessionSummary` object as defined above. 404 if the session id
doesn't exist on disk.

### `GET /api/v1/workspaces/:workspace/teams/:team/sessions/:sid/events` — events

The canonical event log for a session. Two modes selected via the `Accept`
header:

- `Accept: application/x-ndjson` (or unset) — read the file in full as
  newline-delimited JSON. Returns the entire file. One `OtaconEvent`
  JSON per line. Status: 200. `Content-Type: application/x-ndjson`.
  Useful for the UI's "load history" path.

- `Accept: text/event-stream` — opens an SSE stream. Server first replays
  every line of `events.jsonl` from disk as `data: <json>` events (no
  `event:` field — same shape as the live stream), then tails the file
  for new appends. Closes when the session reaches a terminal status.
  Useful for the UI's "watch live" path on a running session.

Both modes use the on-disk `events.jsonl` exclusively — no in-memory
state. This makes every consumer (UI, CLI, future replay tool) see the
same history.

### `GET /api/v1/workspaces/:workspace/teams/:team/sessions/:sid/messages` — messages

Returns `messages.jsonl` as newline-delimited JSON (`Content-Type:
application/x-ndjson`). One `AgentMessage` per line, in conversation
order. The UI uses this to seed the transcript on resume; the CLI uses
it for inspection.

### `GET /api/v1/workspaces/:workspace/teams/:team/sessions/:sid/traces/:tcid/:file` — trace artifact

Serves a per-tool-call trace file. Path components:

- `:tcid` — the tool call id (URL-safe; the agent generates these).
- `:file` — one of `before.png`, `annotated.png`, `after.png`,
  `result.json`.

Resolves to
`${dataRoot}/workspaces/:workspace/teams/:team/sessions/:sid/traces/:tcid/:file`.
Sets `Content-Type: image/png` for `*.png` and `application/json` for
`result.json`. Sets `Cache-Control: private, max-age=86400` because trace
files are immutable after the tool call completes.

404 if the file doesn't exist (e.g., the tool call hasn't completed yet
or the tool didn't produce that artifact).

### `POST /api/v1/escalations/:token/resolve` — resolve a pending escalation

`:token` is the escalation token emitted in `escalation_requested` events
(`<sessionId>:<toolCallId>`). The path component is URL-encoded.

**Request body:**

```ts
interface ResolveEscalationRequest {
  decision: 'approve' | 'reject'
  message?: string          // optional human note relayed back to the agent
}
```

**Response:** `200 OK` with empty body on success.

**Side effects:** rewrites
`${dataRoot}/.../sessions/:sid/escalations/<encoded-token>.json` from
`{status: 'pending'}` to `{status: 'resolved', decision, message}`. The
agent is polling that file and will pick up the change on its next tick.

**Errors:**

- 404 `escalation_not_found` — no file exists for that token.
- 409 `escalation_already_resolved` — file has `status: 'resolved'`
  already.
- 400 `bad_request` — invalid `decision` value.

## SSE event format

Every event sent over `POST /api/v1/runs` and the live mode of `GET
/api/v1/.../sessions/:sid/events` is:

```
data: <json>\n\n
```

where `<json>` is one `OtaconEvent` (defined in
`src/orchestrator/src/types.ts`). The `event:` SSE field is unused — the
event kind lives inside the JSON's `kind` discriminator. This keeps the
on-the-wire format identical to the on-disk `events.jsonl` format, so any
consumer can treat the two interchangeably.

The discriminated union from `types.ts`:

```ts
import type { AgentEvent } from '@mariozechner/pi-agent-core'

interface ScreenshotTriple {
  before: string | null
  annotated: string | null
  after: string | null
}

interface PhoneActionPayload {
  toolCallId: string
  command: string
  subcommand: string
  target: string
  rationale: string
  startedAt: number
  completedAt: number
  exitCode: number
  stdout: string
  stderr: string
  screenshots: ScreenshotTriple
}

interface EscalationPayload {
  prompt: string
  details?: unknown
}

type OtaconEvent =
  | { kind: 'pi'; event: AgentEvent; ts: number }
  | { kind: 'user_message'; text: string; ts: number }
  | { kind: 'system_set'; prompt: string; ts: number }
  | { kind: 'phone_action'; payload: PhoneActionPayload; ts: number }
  | { kind: 'escalation_requested'; token: string; payload: EscalationPayload; ts: number }
  | {
      kind: 'escalation_resolved'
      token: string
      decision: 'approve' | 'reject'
      message?: string
      ts: number
    }
```

The `pi` variant wraps the upstream `AgentEvent` from `@mariozechner/pi-agent-core`.
Notable subtypes the UI needs to handle:

- `agent_start` — agent began processing a message
- `turn_start` / `turn_end` — LLM turn boundaries (delta tokens stream
  between these)
- `tool_call_start` / `tool_call_end` — tool invocations
- `text_delta` — streamed assistant text
- `agent_end` — successful completion (terminal)
- `agent_error` — agent threw (terminal)

The full `AgentEvent` type lives in `pi-agent-core`; consumers should
import it directly rather than re-exporting from this server.

### Trace screenshot paths

`PhoneActionPayload.screenshots.{before,annotated,after}` are filesystem
paths relative to `${ORCHESTRATOR_DATA_DIR}`. The UI MUST NOT load them
directly — instead it converts them to API URLs via the trace route:

```
${ORCHESTRATOR_DATA_DIR}/workspaces/xhs:test/teams/social-media-engagement/sessions/01HXX/traces/abc123/before.png
                                                                                              ^^^^^^ ^^^^^
                                                                                              tcid   file
```

becomes

```
GET /api/v1/workspaces/xhs%3Atest/teams/social-media-engagement/sessions/01HXX/traces/abc123/before.png
```

This indirection lets the server enforce auth, hide the on-disk layout,
and stay forward-compatible with non-local storage.

### Terminal sentinel

After an `agent_end` or `agent_error` Pi event, the server emits one
final SSE line:

```
data: [DONE]\n\n
```

then closes the connection. Clients use the sentinel as the cleanup signal.
This matches the existing CLI consumer's behavior in
`src/orchestrator/static/run.html` and the spike's persisters.

## Data root layout (for reference)

The server is a thin HTTP wrapper around the file tree the spike already
writes. Documented here so consumers can debug by reading files directly.

```
${ORCHESTRATOR_DATA_DIR}/                 # default ".otacon-data"
  workspaces/<workspaceId>/
    workspace.json                        # → /api/v1/workspaces
    credentials.json                      # value never served via API; status only
    env/                                  # → /api/v1/workspaces/:id/env
      persona.md                          #   default-seeded for kind=social
      soul.md                             #   default-seeded for kind=social
      memory.md                           #   default-seeded; agent-managed (renamed from agents.md in Phase I)
    memory/                               # agent's persistent memory dir
    teams/<teamName>/
      last-session.txt                    # session id last written/read
      sessions/<sessionId>/
        session.json                      # → /api/v1/.../sessions/:sid
        messages.jsonl                    # → /api/v1/.../sessions/:sid/messages
        events.jsonl                      # → /api/v1/.../sessions/:sid/events
        sandbox/                          # agent's bash cwd (symlinked)
        traces/<toolCallId>/
          before.png                      # → /api/v1/.../traces/:tcid/before.png
          annotated.png                   # → /api/v1/.../traces/:tcid/annotated.png
          after.png                       # → /api/v1/.../traces/:tcid/after.png
          result.json                     # → /api/v1/.../traces/:tcid/result.json
        escalations/
          <urlEncodedToken>.json          # → POST /api/v1/escalations/:token/resolve
  teams/<teamName>/
    team.yaml                             # → /api/v1/teams[/:name] (Phase I canonical)
    team.json                             # ← legacy; reader still accepts but writer no longer emits
    prompts/<role>.md                     # → /api/v1/teams/:name/prompts/:role
```

## Out of scope for v1

These show up in the longer roadmap but are NOT in this spec:

- Token-based auth on individual routes (Tailscale ingress is the only fence).
- Cancel endpoint for running sessions (`POST /runs/:sid/cancel`).
- Inject-message endpoint for running sessions (`POST /runs/:sid/messages`).
- Account-level credential management beyond opaque PUT/DELETE.
- OpenAPI spec generation (we hand-write this doc; can codegen later).
- Pagination on list endpoints (small data volume; revisit if it grows).
- WebSocket transport (SSE is sufficient; one-way server-to-client is the
  whole need).
