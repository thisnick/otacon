# Orchestrator HTTP API

Contract between the orchestrator web server (`src/orchestrator/server/`,
implemented in Phase B) and its consumers (the web UI in Phase C, the
`orchestrator ui` CLI subcommand in Phase D, and any external automation).

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
| 400 | `bad_request` | Malformed body, missing required field, invalid enum value. |
| 404 | `workspace_not_found` | Path `:workspace` doesn't exist on disk. |
| 404 | `team_not_found` | Path `:team` doesn't exist on disk. |
| 404 | `session_not_found` | Path `:sid` doesn't exist on disk. |
| 404 | `escalation_not_found` | No pending escalation for the given token. |
| 409 | `escalation_already_resolved` | Token has already been resolved. |
| 409 | `workspace_kind_mismatch` | Team's `expectedWorkspaceKind` ≠ workspace's `kind`. |
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
  phone: string             // OtaconClient base URL, full https URL
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
- 404 `workspace_not_found` / `team_not_found` / `session_not_found`.
- 409 `workspace_kind_mismatch`.

Once the stream is open the server commits to writing terminal events,
not HTTP errors. A mid-stream agent failure surfaces as an `agent_error`
Pi event, NOT an HTTP 500.

### `GET /api/v1/workspaces` — list workspaces

```ts
interface WorkspaceSummary {
  id: string
  displayName: string
  kind: string              // "social" or future kinds
  externalRef?: string
  createdAt: number
}

// Response:
type Response = WorkspaceSummary[]
```

Walks `${dataRoot}/workspaces/*/workspace.json`. Stable sort by `id` ascending.

### `GET /api/v1/workspaces/:workspace/teams` — list teams

```ts
interface TeamSummary {
  name: string
  description: string
  expectedWorkspaceKind: string
  lead: string
  agents: Array<{ role: string; model: string; promptFile: string }>
}

type Response = TeamSummary[]
```

Walks `${dataRoot}/teams/*/team.json` and filters to teams whose
`expectedWorkspaceKind` matches the workspace's `kind`. Sort by `name`
ascending.

(Note: `${dataRoot}/teams/` is the global team catalog; teams are not
nested under a workspace on disk. The `:workspace` path param exists so
the route surfaces only teams compatible with this workspace's kind.)

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
    credentials.json                      # NEVER served via API
    env/                                  # workspace env files (RO from agent)
    memory/                               # agent's persistent memory
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
    team.json                             # → /api/v1/.../teams
    prompts/*.md                          # not exposed via API; read via agent
```

## Out of scope for v1

These show up in the longer roadmap but are NOT in this spec:

- Token-based auth on individual routes (Tailscale ingress is the only fence).
- Cancel endpoint for running sessions (`POST /runs/:sid/cancel`).
- Inject-message endpoint for running sessions (`POST /runs/:sid/messages`).
- Workspace/team CRUD beyond read.
- Account/credential management endpoints.
- OpenAPI spec generation (we hand-write this doc; can codegen later).
- Pagination on list endpoints (small data volume; revisit if it grows).
- WebSocket transport (SSE is sufficient; one-way server-to-client is the
  whole need).
