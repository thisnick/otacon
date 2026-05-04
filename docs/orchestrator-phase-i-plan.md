# Phase I — Workspace + Team CRUD APIs + UI

Plan doc. Implementers read this end-to-end before code. Lock-point: once
this is committed to `main`, both server-implementer and web-implementer
build against it. Spec changes mid-flight require lead approval.

---

## 1. Context

After Phase H, the orchestrator is server-only. Browser at the deployed VPS
is the canonical interface. The current data model has a gap: workspaces
and teams are seed-managed (edit `seed.ts`, redeploy). User wants frequent
CRUD over them, plus per-workspace credential management and per-team
prompt iteration.

This phase adds:
- Full CRUD APIs for workspaces and teams (incl. their nested files)
- `phoneNumber` field on workspaces, resolved via registry at run-start
- Drop manual phone URL entry from the run-creation flow
- React + shadcn UI rebuild with sidebar nav + dedicated CRUD pages
- Edit-preserving seed (idempotent)

Existing things that DON'T change:
- The Pi agent loop (`runtime/run.ts`, `tools/`, `sandbox/`)
- The session bus + persistence (events.jsonl, messages.jsonl, traces/)
- The Phase F SSE protocol (`POST /api/v1/runs` shape, `OtaconEvent` types,
  `[DONE]` sentinel)
- The Hono server, Tailscale-on-host topology, Watchtower auto-pull
- The `otacon` phone-control CLI at `src/cli/`

---

## 2. Architectural principles

1. **Filesystem is source of truth.** API CRUD reads/writes
   `${ORCHESTRATOR_DATA_DIR}` directly. No in-memory cache, no DB.
2. **Three first-class resources**: Workspaces, Teams, (read-only) Phones.
   Agents are nested inside teams, not standalone.
3. **Files the harness reads** are structured (YAML/JSON: `team.yaml`,
   `workspace.json`, `credentials.json`). **Files the agent reads as text**
   are markdown (`env/*.md`, `prompts/*.md`). No frontmatter on markdown
   files.
4. **Seed is dev-fixture, not config tool.** Per-resource idempotent: if
   a workspace/team/file already exists, leave it alone. User edits are
   sacred across container restarts.
5. **Server-hosted UI same-origin** (Phase G); CLI is gone (Phase H);
   browser is the canonical interface.
6. **shadcn/ui throughout** for the React UI. pi-web-ui's `MessageList`
   web component reused as a custom element inside React for the run
   transcript only.

---

## 3. Filesystem layout

Existing layout, mostly unchanged. Additions noted with `← NEW`.

```
${ORCHESTRATOR_DATA_DIR}/
  workspaces/
    xhs:test/
      workspace.json              # phoneNumber ← NEW field
      credentials.json            # write-only via API
      env/
        persona.md                # plain markdown, narrative
        soul.md                   # plain markdown, narrative
        memory.md                 # ← RENAMED from agents.md, agent-managed
      memory/                     # agent's RW workspace dir (unchanged)
      teams/<team>/sessions/...   # session data (unchanged)
  teams/
    social-media-engagement/
      team.yaml                   # ← RENAMED from team.json (yaml is human-friendlier)
      prompts/
        lead.md                   # plain markdown, agent system prompt
```

Notes:
- `team.json` → `team.yaml`: implementer migrates seed templates + the
  loader. YAML is more human-friendly when humans edit via UI; the parser
  used is fine with either format. JSON-style keys still work in YAML so
  any downstream tooling that reads JSON-compatible YAML is unaffected.
- `agents.md` → `memory.md`: clarifies semantics ("agent's persistent
  memory across sessions," not "the team's agents").
- No top-level `agents/` directory. Agents are part of `team.yaml`'s
  `agents:` array; their prompts live in `prompts/<role>.md` inside the
  team's directory.

---

## 4. Schemas

### 4.1 `workspace.json` (Workspace)

```jsonc
{
  "id": "xhs:test",                   // unique, URL-safe, "kind:identifier"
  "displayName": "XHS test account",
  "kind": "social",                   // currently only 'social'; extensible enum
  "phoneNumber": "+13412137456",      // E.164 format; ← NEW required field
  "externalRef": "xhs:nick123",       // optional human reference for the social account
  "createdAt": 1714000000000          // ms epoch; immutable after creation
}
```

**Naming convention: camelCase throughout (TS types AND wire format).**
Matches the existing convention in `docs/orchestrator-api.md` and Phase
C/F/G code. Don't switch to snake_case anywhere.

`phoneNumber` is required at create. Run-time resolves to a phone base URL
via `resolvePhone(phoneNumber)` (existing helper at
`src/orchestrator/src/resolve/phone.ts`).

### 4.2 `team.yaml` (Team)

```yaml
name: social-media-engagement
description: "Operates a social media account for warming/engagement."
expectedWorkspaceKind: social         # filters which workspaces this team can run on
lead: engagement-lead                 # role from agents below
agents:
  - role: engagement-lead
    model: anthropic/claude-sonnet-4.6
    promptFile: lead.md               # relative to this team's prompts/ dir
```

Team is self-contained. Agents are an inline array — not separate
resources. If two teams need the same prompt, copy it.

`expectedWorkspaceKind` filters which workspaces can use this team in the
run-creation form (UI's team dropdown is filtered by selected workspace's
kind).

### 4.3 `credentials.json` (Credentials, write-only)

Free-form JSON blob. Schema is platform-specific. Examples:

```jsonc
// for an XHS account, might look like:
{
  "cookies": "session=...",
  "deviceId": "abc123",
  "ua": "Mozilla/5.0 ..."
}
```

Server treats as opaque on storage. API never returns the values. UI's
status indicator shows top-level keys ("Fields set: cookies, deviceId")
without leaking values.

### 4.4 Env files (markdown, plain text)

Three default files seeded into a fresh workspace's `env/` dir:

- **`persona.md`** — surface identity for the social platform. Voice,
  interests, age, location, taboos. The agent reads this verbatim into
  its system prompt.
- **`soul.md`** — deeper character / values / boundaries. Same: read into
  system prompt.
- **`memory.md`** — agent's persistent memory across sessions. Mutable by
  the agent (the lead prompt instructs the agent to write a session
  summary here at end-of-run). Human-editable but flagged "agent-managed."

User can add custom env files (`env/anything.md`). All env files are
concatenated into the system prompt at run-start in alphabetical order
(or in a stable order — implementer choice; document it).

### 4.5 Seed templates (in source code)

`src/orchestrator/scripts/seed-templates/`:

```
seed-templates/
  workspaces/social/
    persona.md                  # default persona content
    soul.md                     # default soul content
    memory.md                   # default memory (mostly empty / instructional)
  teams/social-media-engagement/
    team.yaml
    prompts/
      lead.md                   # default lead-agent prompt
```

These are baked into the binary. `seed.ts` reads them and writes to
`${dataRoot}/...` if the destination doesn't exist. Used at first deploy +
manually invoked for fresh dev environments. **Idempotent**: if the
destination exists, leave it alone.

`seed.ts` no longer creates a default workspace. Workspaces are
user-created via the UI. Only teams + team prompts are seeded.

---

## 5. API spec additions

All under `/api/v1/`. JSON request + response except where noted. Auth:
Tailscale ingress only (unchanged from prior phases). Error envelope shape
is `{error: {code, message, details?}}` (per `docs/orchestrator-api.md`).

### 5.1 Phones (read-only, registry proxy)

```
GET /api/v1/phones
  → 200 [{
      phoneNumber: string             // E.164
      status: 'online'|'offline'|'unreachable'
      registryId: string              // e.g. "phone-4"
      displayLabel: string            // e.g. "Pixel 4a — phone-4"
      hostId: string                  // for filtering by host (rare)
    }]
```

Filters: only phones with non-null `phoneNumber`. Implementation:
orchestrator queries registry's admin phones endpoint with its admin
token, filters + transforms.

### 5.2 Workspaces (full CRUD)

```
GET    /api/v1/workspaces                    → 200 WorkspaceSummary[]    // exists, format unchanged
POST   /api/v1/workspaces                    → 201 Workspace             // ← NEW
GET    /api/v1/workspaces/:id                → 200 Workspace             // exists
PATCH  /api/v1/workspaces/:id                → 200 Workspace             // ← NEW
DELETE /api/v1/workspaces/:id[?force=true]   → 204                        // ← NEW

# Env files
GET    /api/v1/workspaces/:id/env                         → 200 [{name, size, modifiedAt}]
GET    /api/v1/workspaces/:id/env/:file                   → 200 text/markdown raw
PUT    /api/v1/workspaces/:id/env/:file                   → 200 (text/markdown body)
DELETE /api/v1/workspaces/:id/env/:file                   → 204
POST   /api/v1/workspaces/:id/env/:file/reset             → 200 text/markdown (resets to seed default)

# Credentials (write-only)
GET    /api/v1/workspaces/:id/credentials                 → 200 {hasCredentials: bool, fieldsSet: string[]}
PUT    /api/v1/workspaces/:id/credentials                 → 200 (JSON body, server stores as-is)
DELETE /api/v1/workspaces/:id/credentials                 → 204
```

**`POST /workspaces` request body:**
```ts
{
  id: string                  // required, unique, format "kind:identifier"
  displayName: string        // required
  kind: 'social'              // required (currently only enum value)
  phoneNumber: string        // required, E.164 format
  externalRef?: string       // optional
}
```

Server side-effects on create:
1. Validates `id` format, `phoneNumber` E.164 format, no existing
   workspace at that id
2. Creates `${dataRoot}/workspaces/<id>/` dir
3. Writes `workspace.json` with `createdAt` set to now
4. Bootstraps `env/{persona,soul,memory}.md` from `seed-templates/workspaces/<kind>/`
5. Creates empty `memory/` dir
6. Returns the full Workspace object

Error codes:
- `badRequest` (400): missing fields, invalid id format, invalid E.164
- `workspaceAlreadyExists` (409): id collision
- `phoneNumber_unresolvable` (400): warning only — accept the value but
  return `{error}` with a 400 IF the phone isn't currently in registry
  AND the request didn't include a `force_phoneNumber: true` field. (See
  validation discussion below.)

**`PATCH /workspaces/:id` request body:**

Subset of Workspace fields. `id` and `createdAt` are immutable.
`displayName`, `phoneNumber`, `externalRef`, `kind` are mutable.

**`DELETE /workspaces/:id`:**

- Without `?force=true`: 409 `workspaceHasSessions` if any sessions exist
  in `workspaces/<id>/teams/*/sessions/`. Otherwise 204.
- With `?force=true`: cascade-deletes the entire workspace dir
  (sessions, traces, memory, env, credentials). 204.

### 5.3 Teams (full CRUD)

```
GET    /api/v1/teams                              → 200 TeamSummary[]   // already partially exists (per workspace kind); generalize
POST   /api/v1/teams                              → 201 Team
GET    /api/v1/teams/:name                        → 200 Team
PATCH  /api/v1/teams/:name                        → 200 Team
DELETE /api/v1/teams/:name[?force=true]           → 204

# Per-agent prompts (markdown, raw text)
GET    /api/v1/teams/:name/prompts/:role          → 200 text/markdown
PUT    /api/v1/teams/:name/prompts/:role          → 200 (text/markdown body)

# Reset to seed defaults
POST   /api/v1/teams/:name/reset                  → 200 Team (after reset)
POST   /api/v1/teams/:name/prompts/:role/reset    → 200 text/markdown
```

`Team` shape mirrors `team.yaml`. `agents[].promptFile` is computed by
the server (`<role>.md`); clients don't set it directly. Adding/removing
agents is via PATCH on the team's `agents` array; the server creates
`prompts/<role>.md` (empty or seeded if a default exists) when an agent
is added, deletes the file when an agent is removed.

`GET /api/v1/teams?workspaceKind=social` filters to teams matching that
kind. UI uses this for the team dropdown after a workspace is selected.

### 5.4 Run creation — drop `phone` field

```
POST /api/v1/runs
  body: {
    workspace: string,        // required
    team: string,             // required
    userMessage: string,     // required
    resume?: 'last' | 'new' | string,    // optional, default 'last'
    autoApprove?: boolean,
    autoReject?: boolean,
    modelProvider?: string
    // ← `phone` field REMOVED
  }
```

Server-side at run-start:
1. Loads workspace, reads `phoneNumber`
2. Calls `resolvePhone(phoneNumber)` to get the phone base URL
3. Returns 400 `phoneUnresolvable` with the workspace's phoneNumber in
   `details` if the registry doesn't currently have it online
4. Otherwise proceeds as today

`docs/orchestrator-api.md` updated to reflect the removed field and the
new error code.

---

## 6. UI / IA

### 6.1 Stack

- React 19 + TypeScript
- Vite (existing build setup)
- React Router (hash mode for parity with existing routes)
- shadcn/ui components (added via `npx shadcn@latest add` per the
  shadcn skill)
- Tailwind CSS v4 (compatible with shadcn's defaults)
- react-hook-form + zod for forms
- TanStack Table (via shadcn `data-table` block) for lists
- sonner for toasts

`pi-web-ui`'s `MessageList` lit web component is **kept** and embedded
inside React's `RunDetail` page as a custom HTML element. No replacement.
The transcript is the bit pi-web-ui already does well.

### 6.2 Layout

shadcn `sidebar-01` block. Left sidebar (collapsible to icons on narrow
viewports), main content area on the right. Breadcrumb at the top of
content.

```
┌──────────────────┬─────────────────────────────────────────────┐
│ otacon           │ Workspaces > xhs:test                        │
│ orchestrator     │ ───────────────────────────────────────────  │
│                  │                                              │
│ ▸ Runs           │  [page content]                              │
│   Workspaces     │                                              │
│   Teams          │                                              │
│                  │                                              │
│ ─────────        │                                              │
│                  │                                              │
│ ● healthy        │                                              │
│ Light/Dark/Sys   │                                              │
└──────────────────┴─────────────────────────────────────────────┘
```

Sidebar pieces (from shadcn `Sidebar` primitive set):
- `SidebarHeader`: app name + version pill
- `SidebarContent` / `SidebarMenu` / `SidebarMenuItem`: 3 nav items, active
  route highlighted
- `SidebarFooter`: server health pill + theme toggle (`DropdownMenu`:
  Light/Dark/System)
- `SidebarTrigger`: hamburger for mobile

### 6.3 Routes

Hash-mode routing:

| Route | Purpose |
|---|---|
| `#/` | Runs list (default landing) |
| `#/runs/:sid` | Run detail (existing pattern, rebuilt with React+shadcn shell, transcript = embedded `<message-list>`) |
| `#/workspaces` | Workspaces list |
| `#/workspaces/:id` | Workspace detail (tabs: Settings, Env files, Credentials, Sessions) |
| `#/teams` | Teams list |
| `#/teams/:name` | Team detail (tabs: Settings, Agents) |

Tab state lives in `?tab=` query param: `#/workspaces/xhs:test?tab=env`.
Persists across reload + shareable.

### 6.4 Page-by-page shadcn map

#### `#/` Runs list

- `data-table` with columns: ID (truncated ULID, monospace), Workspace,
  Team, Status (`badge` with color), Started (relative time), Duration
- Filter toolbar above table: 3x `select` (Workspace / Team / Status) +
  search field
- `button` "+ Start new run" (primary, top-right) → `dialog`:
  - `form` with `select` workspace, `select` team (dependent on
    workspace.kind), `textarea` prompt, `checkbox` auto-approve
  - Submit → POST `/runs`, on 200 → navigate to `#/runs/:sid` + `toast`
- Empty state: card with heading "No runs yet" + CTA to workspaces

#### `#/runs/:sid` Run detail

- Header `card`: run id (copyable), workspace, team, status `badge`,
  started, duration, "Cancel run" button (only if running)
- Embedded `<message-list>` web component for transcript (live SSE tail
  if running, replay if completed) — unchanged from current code
- "Send follow-up message" `card` at bottom: `textarea` + `button`,
  posts to existing session

#### `#/workspaces` Workspaces list

- `data-table` columns: ID, Display name, Kind (`badge`), Phone (custom
  cell: status dot + last-4 digits + tooltip with full FQDN of resolved
  phone), Sessions count, Created
- `button` "+ New workspace" → `dialog` + `form`:
  - `input` ID (with format hint)
  - `input` Display name
  - `select` Kind
  - `combobox` Phone number — sourced from `GET /api/v1/phones`,
    searchable, items show `+13412137456 — phone-4 (online)`
  - `input` External ref (optional)
  - Submit → POST `/workspaces`, navigate to detail

#### `#/workspaces/:id` Workspace detail

- Header card with breadcrumb + `badge`s for kind + phone status
- `tabs`: Settings · Env files · Credentials · Sessions

**Settings tab:**
- `form` (react-hook-form + zod):
  - Display name `input`
  - Phone number `combobox` (same as create)
  - External ref `input`
  - Kind `select`
- `button` Save (disabled when not dirty) → PATCH
- Bottom: red `alert-dialog` "Delete workspace" — shows session count,
  requires typed-id confirmation, force-flag toggle

**Env files tab:**
- List of `card`s, one per env file. Each:
  - Header: filename + size + last-modified
  - `textarea` (markdown editor — auto-resizing, monospace)
  - `button` Save (PUT)
  - `button` Reset to default (`alert-dialog` confirm with diff preview)
  - `button` Delete (`alert-dialog` confirm)
  - For `memory.md`: yellow `alert` strip "agent-managed; the agent may
    rewrite this between sessions"
- "+ New env file" → `dialog`: filename + initial content

**Credentials tab:**
- `alert` strip showing status: "Credentials set (3 fields)" or
  "No credentials" (color-coded)
- `textarea` for JSON entry (write-only — never pre-populated)
- "Validate JSON" inline button (parses + shows errors)
- `button` Save (PUT)
- `button` Wipe (`alert-dialog` confirm)
- Below: read-only listing of `fieldsSet` (just key names)

**Sessions tab:**
- Reused `data-table` filtered to this workspace; rows link to run detail

#### `#/teams` Teams list

- `data-table`: Name, Description (truncated), Workspace kind (`badge`),
  Lead, # of agents
- `button` "+ New team" → `dialog`: name + description + workspaceKind
  `select`. Created with no agents; user adds agents on detail page.

#### `#/teams/:name` Team detail

- Header card + breadcrumb
- `tabs`: Settings · Agents

**Settings tab:**
- `form`: description, workspaceKind, lead `select` (from current agents)
- Save / Reset team.yaml to default / Delete team (with cascade flag)

**Agents tab:**
- List of `card`s, one per agent. Each:
  - Role (read-only after create) + `badge` if it's the lead
  - Model `input`
  - Prompt `textarea` (markdown editor)
  - Save / Reset prompt to default / Remove agent (with `alert-dialog`)
- "+ Add agent" → `dialog`: role + model + initial prompt content

### 6.5 Reusable components (`src/components/shared/`)

- `<StatusBadge status="online|offline|running|completed|failed" />` — typed wrapper around `badge`
- `<PhoneCombobox value setValue />` — sources from `/phones`, with free-form fallback
- `<ConfirmDialog title body trigger destructive />` — wraps `alert-dialog` with the typed-confirmation pattern

### 6.6 Theme

shadcn's standard system: `ThemeProvider` (using `next-themes` or a
hand-rolled equivalent for Vite). `globals.css` carries the shadcn token
scheme (light + dark variants). `.dark` class on root toggles. Picker in
sidebar footer.

### 6.7 Loading / empty / error patterns

Uniform across pages:
- **Loading**: `skeleton` rows in tables, `skeleton` cards in tabs
- **Empty**: shadcn `card` with heading + CTA
- **Mutation success**: `sonner` toast top-right
- **Mutation failure**: `sonner` toast in destructive variant; persists until dismissed
- **Page-level error**: `alert` at top of content with retry button; nav stays accessible

### 6.8 Folder structure (web/)

```
src/orchestrator/web/
├── components.json                    ← shadcn config
├── package.json                       ← React + react-router + react-hook-form + zod + sonner
├── tailwind.config.ts                 ← shadcn-compatible tokens
├── vite.config.ts
├── index.html
└── src/
    ├── main.tsx                       ← React entry + root
    ├── App.tsx                        ← Layout + Router
    ├── lib/
    │   ├── api-client.ts              ← reused (HTTP + SSE)
    │   ├── event-handler.ts           ← reused
    │   ├── types.ts                   ← reused (OtaconEvent + etc.)
    │   └── utils.ts                   ← cn() from shadcn
    ├── components/
    │   ├── ui/                        ← shadcn primitives (npx shadcn add)
    │   ├── layout/                    ← AppSidebar, BreadcrumbBar, ThemeProvider
    │   ├── workspaces/                ← list, dialogs, env editor, credentials form
    │   ├── teams/                     ← list, dialogs, agent editor
    │   ├── runs/                      ← list, dialogs, run detail wrapper
    │   └── shared/                    ← StatusBadge, PhoneCombobox, ConfirmDialog
    ├── pages/
    │   ├── runs-page.tsx
    │   ├── run-detail-page.tsx
    │   ├── workspaces-page.tsx
    │   ├── workspace-detail-page.tsx
    │   ├── teams-page.tsx
    │   └── team-detail-page.tsx
    └── globals.css                    ← Tailwind + shadcn tokens
```

---

## 7. Migration

### 7.1 Existing `xhs:test` workspace (on deployed VPS)

After Phase I server lands + image deploys, the existing `xhs:test`
workspace.json has no `phoneNumber` field. Two options:

1. **PATCH via API** (preferred):
   ```bash
   curl -X PATCH https://otacon-orchestrator.tail0437b8.ts.net/api/v1/workspaces/xhs%3Atest \
     -H 'Content-Type: application/json' \
     -d '{"phoneNumber":"+13412137456"}'
   ```
2. **UI**: open `#/workspaces/xhs:test`, set phone number in Settings tab,
   save. Equivalent.

Either is one-shot and preserves all sessions, traces, env files.

### 7.2 Existing `social-media-engagement` team

Team config will be migrated by the server-implementer:
- Rename `team.json` → `team.yaml` (loader updated to handle either, but
  writes yaml from now on)
- Confirm `agents[].promptFile` is `lead.md` (matches current shape)
- No other change

### 7.3 Existing `agents.md` env file

Renamed in seed template to `memory.md`. Existing deployed workspaces with
`agents.md` are auto-renamed by the server on first read (a one-shot
migration in the env-file loader: if `memory.md` doesn't exist but
`agents.md` does, rename + log). Implementer's call on whether to keep
this auto-migration in code permanently or as a one-shot.

### 7.4 Seed updates

`seed.ts` becomes:
- Reads `seed-templates/teams/<name>/` for each default team
- For each team: if `${dataRoot}/teams/<name>/team.yaml` doesn't exist,
  copy the template tree
- For each prompt file: same per-resource idempotency
- Does NOT seed any workspaces (deferred to user via UI)
- Does NOT touch credentials

Run via `pnpm --filter orchestrator seed` (existing script). Docker
container's first-boot hook (cloud-init) calls it. Manual invocations OK.

---

## 8. Test plan (evaluator-owned)

**Server-side e2e**, committed to `tests/orchestrator/e2e/phase-i-*.ts`:

| Test | Scenario |
|---|---|
| I1 | Workspaces CRUD: create, get, patch, delete (with + without force), validation errors |
| I2 | Env files CRUD: list, get, put (write content), delete, reset-to-default |
| I3 | Credentials write-only: status, put, get returns no values, wipe |
| I4 | Teams CRUD: create, patch (add/remove agent), delete, prompt CRUD per role, reset |
| I5 | Phones list: returns registry data filtered to phoneNumber-having phones |
| I6 | Run with workspace.phoneNumber resolution (replaces phase-f F1's phone field) |
| I7 | Seed idempotency: write workspace, run seed, content preserved |

**UI e2e** via Playwright, committed to `tests/orchestrator/e2e/phase-i-ui-*.ts`:

| Test | Scenario |
|---|---|
| I-UI1 | Sidebar nav: 3 items, active highlight, theme toggle works |
| I-UI2 | Workspaces list → create → detail → edit → delete (full lifecycle) |
| I-UI3 | Env file editor: edit `persona.md`, save, refresh, content persists |
| I-UI4 | Credentials form: save credentials, status shows fieldsSet, never returns values |
| I-UI5 | Teams list → create → add agent → edit prompt → delete |
| I-UI6 | Run flow: dropdown shows seeded workspace, picks team, no phone field, run starts |
| I-UI7 | Phone combobox: dropdown sourced from registry, free-form fallback works |

**Regression checks** (don't re-run unless suspicious):
- Phase F's f1 (API smoke), f5 (escalation), f7 (trace PNG), f8 (XHS canonical)
- Phase G's g1 (deployed root URL serves UI), g2 (F1 regression), g3 (F8 regression)

---

## 9. Scope split

### 9.1 server-implementer

Scope:
- All API routes in §5
- `WorkspaceStore`, `TeamStore`, `EnvFileStore`, `CredentialsStore`,
  `PhoneStore` (last is a thin registry proxy) modules
- YAML reading/writing (use `yaml` npm package)
- Seed updates (per §7.4) including idempotent merges
- Drop `phone` field from `POST /runs`; resolve from `workspace.phoneNumber`
- One-shot `agents.md` → `memory.md` migration
- Update `docs/orchestrator-api.md` — every new endpoint, every new error code
- Author Phase I server-side e2e (I1-I7) at `tests/orchestrator/e2e/phase-i-*.ts`

NOT in scope for server-implementer:
- React UI (web-implementer)
- Deploy (evaluator)
- shadcn config
- Auth changes (still Tailscale-only)

### 9.2 web-implementer

Scope:
- Initialize React + shadcn in `src/orchestrator/web/` (uses shadcn skill)
- App layout (sidebar + breadcrumb + theme provider)
- All 6 pages per §6.4
- All shared components per §6.5
- Reuse existing `api-client.ts`, `event-handler.ts`, `types.ts`
- Embed pi-web-ui's `<message-list>` inside RunDetail page (declare as
  intrinsic JSX element)
- Drop the existing top-nav + page templates (rebuild on shadcn shell)
- Author Phase I UI e2e (I-UI1–I-UI7) using Playwright at
  `tests/orchestrator/e2e/phase-i-ui-*.ts`

NOT in scope for web-implementer:
- Server-side API (server-implementer)
- Deploy (evaluator)
- Backend tests
- Modifying the agent loop

### 9.3 Coordination

- Implementers DON'T talk directly. They coordinate via this doc + the
  spec at `docs/orchestrator-api.md`.
- Both build on `pi-spike` ... wait, `pi-spike` is dead now. Both build on
  a new branch `phase-i` cut from `main` at HEAD `9f40e6f`.
- Standard merge cadence: each pushes commits to `phase-i`. Conflicts are
  rare (different file trees) but pull-before-push.
- Ping lead with TaskUpdate + SendMessage at surface gates per phase
  protocol.

### 9.4 Evaluator (later)

After both implementers hand off:
- Single `phase-i-evaluator` runs the test plan (§8)
- Authors / runs the I1-I7 + I-UI1-I-UI7 scripts
- Runs `make orchestrator-deploy` against deployed VPS
- Final sign-off + main-merge surfaced to user

---

## 10. Out of scope

- Multi-platform credential schemas (per `kind` typing of credentials JSON)
- Search/pagination on lists (small data sets; revisit if >50 rows)
- Audit log for resource edits
- Real-time collaborative editing
- Mobile-optimized layouts (responsive will exist; mobile-first not a priority)
- Top-level `agents/` directory (shared agents across teams) — explicitly
  rejected this phase; teams self-contain their agents
- Frontmatter-typed env files (kept as plain markdown)
- Soft-delete / `.trash/` (hard-delete only)
- Workspace bulk-create from registry phones list (UI creates one at a time)
- Reset-individual-fields (Settings tab is "Reset to default" all-or-nothing)
- Account import/export
- Theme customization beyond Light/Dark/System

---

## 11. Effort estimate

- server-implementer: ~1.5 days
- web-implementer: ~3 days (initial shadcn init + 6 pages + e2e)
- evaluator: ~half day
- Total: ~5 days end-to-end (server + UI in parallel)

---

## 12. References

- `docs/orchestrator-api.md` — current API contract (server-implementer
  amends this in their PR)
- `docs/orchestrator-v2-plan.md` — load-bearing decisions appendix
  (Tailscale, registry URL, OTACON_TOKEN, etc.) — preserved
- `src/orchestrator/src/resolve/phone.ts` — existing phone-number resolver
- `src/orchestrator/web/src/lib/api-client.ts` — existing HTTP+SSE client
  to extend
- pi-web-ui's `MessageList` — kept as web component, embedded in React
- shadcn skill — used by web-implementer for component installation +
  theme + debugging
