# Orchestrator V2: HTTP API + Streaming + File Backend + Web UI + VPS

> **Source of truth.** This file is the working plan for the orchestrator-v2
> redesign. When details change (decisions revised, scope split between phases,
> APIs corrected), edit this file in-tree. The previous local copy at
> `~/.claude/plans/calm-churning-panda.md` is obsolete from 2026-04-29 onward.

## Context

The agent orchestrator at `src/orchestrator/` works but is hard to follow and validate. Today it:
- Runs as a CLI on the dev machine (no remote service)
- Persists state to Neon Postgres (external dep, slow setup)
- Has no UI for inspecting runs
- Has no clean way to stream events live or block on completion
- Targets the Pi for execution, but the Pi is too feeble

The redesign turns the orchestrator into a **headless service deployed to a VPS** with a **web UI for run inspection**. The Pi only runs phones; the orchestrator runs elsewhere and reaches the Pi over Tailscale.

Goals (from user direction):
1. HTTP API: orchestrator runs as a server; CLI/UI/webhooks call it
2. Streaming: CLI invocation blocks until the workflow completes (or agent returns final text), receiving events live
3. **File-based everything** — no SQL, no SQLite. Pure filesystem with index files
4. **Three storage concerns**: account environment (mounted RO into agent), conversations (per-agent, not per-team), record-keeping (run history, events)
5. Separate Docker image deployed to a VPS (not Pi)
6. Ansible-driven deploy mirroring the Pi flow
7. Web UI for run visualization + approval/reject of tool calls
8. **Auto-screenshot every phone action** with annotated overlays (where the tap/swipe lands)
9. **Snapshot the prompt at run time** so old runs show the actual prompt used, even after code changes
10. Use AI SDK's streaming mechanism for live agent output; persist posterity events (screenshots, etc.) alongside
11. UI is static + queries the API; everything visible in UI is also accessible via CLI

## Decisions (confirmed)

| Question            | Decision                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------- |
| Backend             | **Filesystem only** — JSON files for state, append-only JSONL index files for fast list scans |
| Streaming protocol  | Server-Sent Events (SSE), forwarding AI SDK's UI message stream + posterity events            |
| HTTP framework      | Hono (small, Node-native, matches the static-UI pattern we already use)                       |
| UI framework        | Static SPA — vanilla HTML+JS+CSS (matches `src/registry/static/`)                             |
| Conversation scope  | Per-agent (not per-team) — even when agents talk to each other later, each gets its own       |
| Prompt snapshotting | Render once at run start, write to `runs/{id}/prompt.md`; never re-render for historical runs |
| Auto-screenshots    | Wrapper around `otacon` in just-bash captures before/after, draws action annotation overlay   |
| Approvals           | Web UI (and CLI) sends `POST /signals/{id}/resolve`; replaces stdin gating                    |
| Existing team       | Keep `social-media-engagement` as the only team in V2                                         |
| VPS provider        | Pluggable — Ansible role agnostic; tested on Oracle Cloud Free Tier                           |
| Network             | Orchestrator VPS joins our Tailscale net (same pattern as registry)                           |
| Ansible scope       | First boot manual (cloud-init), then Ansible installs Docker + Tailscale + pulls images       |

## Architecture

```
                ┌─────────────────────────────────────────┐
                │ User                                    │
                │  ├─ CLI (`orchestrator agent run ...`)  │
                │  ├─ Browser (web UI)                    │
                │  └─ Webhook callers (relay, cron)       │
                └────────────────┬────────────────────────┘
                                 │ HTTPS over Tailscale
                  ┌──────────────▼──────────────────────┐
                  │ Orchestrator VPS (Tailscale node)   │
                  │                                     │
                  │  ┌─ Hono HTTP server (port 9090)    │
                  │  │   - REST: /api/v1/*              │
                  │  │   - SSE:  /api/v1/runs/{id}/stream│
                  │  │   - Static: / (web UI)           │
                  │  │                                  │
                  │  ├─ Run executor (in-process)       │
                  │  │   - DurableAgent loop            │
                  │  │   - just-bash sandbox with       │
                  │  │     auto-screenshot wrapper      │
                  │  │   - Per-run event emitter        │
                  │  │                                  │
                  │  └─ Filesystem (.orchestrator-data) │
                  └──────────────┬──────────────────────┘
                                 │ Tailscale private
                ┌────────────────▼────────────────────┐
                │ Pi host (otacon-server)             │
                └─────────────────────────────────────┘
```

## Filesystem layout

Everything lives under `ORCHESTRATOR_DATA_DIR` (default `.orchestrator-data/` locally, `/data/orchestrator/` in the container).

```
.orchestrator-data/
  accounts/
    xhs:test/
      account.json                    # {id, displayName, accountType, status, createdAt, config}
      credentials.json                # array of credentials (encrypted later, plain for now)
      env/                            # mounted RO into the agent's filesystem
        persona.md                    # user-defined identity
        soul.md                       # deeper personality
        agents.md                     # team & roles description
      workspace/                      # mounted RW; agent writes here
        posts/
        reflection/
        scratch/

  teams/
    social-media-engagement/
      team.json                       # {name, agents: [{role, model, promptFile}], ...}
      prompts/
        engagement-lead.md
        soul.md
        tools.md
        # any file referenced by team.json

  runs/
    01J9WV.../                        # ULID = our orchestrator runId
      run.json                        # metadata; includes workflowRunId from Workflow SDK
      prompt.md                       # SNAPSHOT of the system prompt used at run start
      traces/
        {tool_call_id}/
          before.png                  # auto-captured
          annotated.png               # overlay marking the action target
          after.png                   # auto-captured
          result.json                 # raw bash result (stdout/stderr/exit code)
      signals/
        {signal_id}.json              # {hook_token, status, command, rationale, ...}
        # Workflow SDK's hook() handles suspension; we just track metadata here

  # The chunk stream itself lives under Workflow SDK's storage:
  workflow/
    runs/{workflow_run_id}/...        # @workflow/world-local FS layout
                                      # contains all UIMessageChunks (text-delta, tool-call,
                                      # tool-result, data-*) ready to be replayed via
                                      # run.getReadable({startIndex})

  index/
    runs.jsonl                        # one line per run; append on create/status change
    by-account/
      xhs:test.jsonl                  # per-account run index
    by-status/
      running.jsonl
      completed.jsonl
      failed.jsonl
```

### Why no SQL

- **No external dep** to set up — `mkdir` works
- **Index files are append-only JSONL** — fast streaming reads, durable, cheap to write
- **Events are individual files** with sortable filenames — list/filter via `glob` and prefix matching
- **Single-writer per run** — the run executor owns `runs/{id}/*` for the lifetime of the run; no concurrent-write contention
- **Index drift recovery**: `scripts/rebuild-index.ts` walks `runs/*/run.json` and rewrites `index/`. Run on demand or on startup.

### Index file format (`runs.jsonl`)

```jsonl
{"id":"01J9WV...","account":"xhs:test","team":"social-media-engagement","status":"running","startedAt":1714...}
{"id":"01J9WV...","account":"xhs:test","team":"social-media-engagement","status":"completed","startedAt":1714...,"completedAt":1714...}
```

Status changes append a new line with the new status — last entry per `id` wins. List queries scan and dedupe in memory (file is bounded to \~few MB; if it grows beyond that we add rotation).

### Run metadata (`runs/{id}/run.json`)

```json
{
  "id": "01J9WV...",                                   /* our orchestrator runId */
  "workflowRunId": "wfrun_abc...",                     /* Workflow SDK's runId — used for getReadable() */
  "account": "xhs:test",
  "team": "social-media-engagement",
  "agentRole": "engagement-lead",
  "model": "alibaba/qwen3.6-plus",
  "promptTemplatePaths": ["teams/social-media-engagement/prompts/engagement-lead.md", "..."],
  "promptSnapshotPath": "runs/01J9WV.../prompt.md",
  "initialPrompt": "post the spring lookbook today",
  "status": "running",                                 /* created|running|completed|failed|cancelled */
  "startedAt": 1714...,
  "completedAt": null,
  "finalText": null,
  "error": null,
  "turnCount": 0
}
```

The `workflowRunId` field is the bridge to Workflow SDK. When the HTTP route needs to serve the stream, it does `getRun(orchestratorRunId).workflowRunId → workflow.run(workflowRunId).getReadable({startIndex})`.

## Storage abstraction

Storage is exposed through **method-level interfaces** with a single FS-backed implementation today. Callers never touch paths or `fs.*` directly — they go through `runStore.create(...)`, `blobStore.putScreenshot(...)`, etc. This keeps the door open for swapping backends later (S3, sqlite, whatever) without rewriting call sites.

Five abstractions, one FS implementation each:

```typescript
// src/orchestrator/src/storage/account-store.ts
export interface AccountStore {
  create(account: AccountInput): Promise<Account>
  get(id: string): Promise<Account | null>
  list(): Promise<Account[]>
  readEnvFile(accountId: string, relPath: string): Promise<string | null>
  writeEnvFile(accountId: string, relPath: string, content: string): Promise<void>
}

// src/orchestrator/src/storage/team-store.ts
export interface TeamStore {
  list(): Promise<TeamMeta[]>
  get(name: string): Promise<TeamConfig | null>
  readPromptFile(teamName: string, relPath: string): Promise<string>
}

// src/orchestrator/src/storage/run-store.ts
// Workflow SDK persists the chunk stream — RunStore only handles metadata.
export interface RunStore {
  create(run: RunInput): Promise<Run>                                  // writes run.json + index entry
  get(runId: string): Promise<Run | null>                              // reads run.json
  list(opts?: ListRunsOpts): Promise<Run[]>                            // reads from index/runs.jsonl
  updateStatus(runId: string, status: RunStatus, fields?: Partial<Run>): Promise<void>
  putPromptSnapshot(runId: string, prompt: string): Promise<string>    // writes prompt.md, returns path
  getPromptSnapshot(runId: string): Promise<string | null>             // reads prompt.md
  // Note: messages and events are NOT here — Workflow SDK owns the chunk stream.
}

// src/orchestrator/src/storage/blob-store.ts
export interface BlobStore {
  // Generic blob ops (existing API kept)
  put(path: string, bytes: Buffer | Uint8Array): Promise<string>
  get(path: string): Promise<Buffer | null>
  exists(path: string): Promise<boolean>
  list(prefix: string): Promise<string[]>

  // Specialized helpers — what callers actually use
  putScreenshot(runId: string, toolCallId: string, kind: 'before' | 'annotated' | 'after', bytes: Buffer): Promise<string>
  getScreenshot(runId: string, toolCallId: string, kind: 'before' | 'annotated' | 'after'): Promise<Buffer | null>
  putToolResult(runId: string, toolCallId: string, result: unknown): Promise<string>
  getToolResult(runId: string, toolCallId: string): Promise<unknown | null>
}

// src/orchestrator/src/storage/signal-store.ts
// Tracks signal metadata + maps signal_id → workflow hook token.
// Suspension itself is handled by Workflow SDK's hook() — not by this store.
export interface SignalStore {
  create(runId: string, signal: SignalInput): Promise<Signal>          // assigns signal_id, persists hook token
  get(signalId: string): Promise<Signal | null>
  list(opts?: { runId?: string; status?: SignalStatus }): Promise<Signal[]>
  markResolved(signalId: string, decision: 'approve' | 'reject' | 'skip', message?: string): Promise<Signal>
  // No awaitResolution — that's resumeHook(token) at the route handler.
}
```

The signature is what callers see. Implementations live next to interfaces (`run-store-fs.ts`, `blob-store-fs.ts`, etc) and a small `factory.ts` wires them up at startup.

The existing `LocalBlobStore` is renamed to `BlobStoreFs` and gets the specialized helpers added; its generic `put`/`get`/`list` API is preserved unchanged.

The chunk stream (the conversation transcript) is intentionally NOT one of these stores — Workflow SDK owns that. Our stores deal only with metadata, assets, and config that live outside the chunk stream.

## We use Workflow SDK + AI SDK. We don't write streaming protocol.

Two SDKs do the heavy lifting; we don't write SSE protocol code or stream-replay code ourselves.

### AI SDK provides the wire protocol

- `createUIMessageStream({execute})` — build a stream by feeding chunks through `writer.write(chunk)`
- `createUIMessageStreamResponse({stream})` — wrap a stream as a `Response` with correct SSE framing
- `readUIMessageStream({stream})` — consume a chunk stream and produce `UIMessage[]` (server or client)

Wire format = one `data: {json}\n\n` per chunk. We never serialize SSE manually.

### Workflow SDK provides the durable run + resumable stream

- `start(workflow, args)` — launch a durable run; returns `Run` with `runId`, `readable`, `getReadable({startIndex})`
- `"use workflow"` — marks a function as a workflow body (runs on the workflow runtime, deterministic)
- `"use step"` — marks a function as a step (atomic, retried on failure, can do non-deterministic IO)
- `getWritable({namespace?})` — from inside a step, get the run's writable to push chunks
- `sleep(duration)` — durable sleep; survives orchestrator restarts. Replaces `setTimeout`.
- `hook<T>()` + `resumeHook(token, value)` — durable suspension; the workflow `await hook` pauses until an external caller resumes it. Clean primitive for approvals.
- Stream persistence — chunks are stored by the SDK (Redis on Vercel, filesystem with `@workflow/world-local`). `getReadable({startIndex})` resumes from any point.

We're already on the dependency list (`workflow`, `@workflow/world-local`, `@workflow/ai` are in `package.json`). The current code just hasn't wrapped the agent loop in a workflow yet (the "Phase A" in-process model). This redesign is the move to Phase B.

### What this means concretely for our orchestrator

| Concern | What we DON'T write | What we use |
|---|---|---|
| SSE wire framing | Manual `data: ... \n\n` lines | `createUIMessageStreamResponse({stream: run.readable})` |
| Stream persistence | A JSONL file per chunk | Workflow SDK auto-persists `getWritable()` chunks via `@workflow/world-local` (FS-backed) |
| Resumable replay | Custom Last-Event-Id replay over our FS | `run.getReadable({startIndex})` |
| Sleep across restarts | A custom resume queue + setTimeout | `sleep("3h")` inside the workflow body |
| Approval suspension | An in-memory `Map<signalId, resolver>` | `hook<Decision>()` + `resumeHook(token, decision)` from the HTTP route |
| Live + late subscribers | Tee chunks to in-memory bus + persist | `run.readable` is one stream serving both |

### What we still write ourselves

Workflow SDK persists the chunk stream. It does NOT persist:
- Run metadata (`run.json`) — our concept, not theirs
- Prompt snapshot — for "what prompt was used"
- Screenshots & trace artifacts — too big for the chunk stream; referenced by URL
- Account environment — agent's read-only mounts
- Index files (`runs.jsonl`) — for fast list scans

So our storage abstraction (RunStore, AccountStore, BlobStore, SignalStore) shrinks: it stops dealing with messages and event chunks, and only handles metadata + assets + indexes.

### Constraints we accept

- **Workflow body must be deterministic for replay**: no `Date.now()`, no `Math.random()`, no direct IO. We isolate non-determinism into `"use step"` functions (which are persisted-once, retried, and idempotent). Pattern is well-documented; section 7 of the original design doc spells it out.
- **`start()` and `resumeHook()` must be in steps**: not in the workflow body. Original design doc covers this verbatim.
- **Hook tokens must be deterministic**: derived from stable inputs, never `Date.now()` or random. Same idempotency rules from section 7 of the design doc apply.

### What we explicitly skip (not motivated by current scope)

- **Cross-serverless durability via `world-vercel`**: we run in a single VPS process — `world-local` is sufficient. We get the durability primitives without paying the serverless tax.
- **Sub-agent fan-out via `start()`**: the section-7 fire-and-forget pattern is for multi-agent teams; we have one agent in this scope.
- **`useChat` integration**: our UI is vanilla HTML/JS for now; we consume the SSE directly. We can drop in `WorkflowChatTransport` later if we move to React.

## What we persist vs what we stream

A clean separation. We **don't** store every SSE chunk — AI SDK already gives us the canonical transcript and we'd just be saving redundant deltas.

### Why we don't store messages or chunks

DurableAgent does NOT output `UIMessage[]` directly — it gives back `ModelMessage[]` in `result.messages` and streams `UIMessageChunk` through the writable. Either could be a candidate for "what to persist."

**We don't persist either**, because Workflow SDK already does. The chunks pushed via `getWritable()` are auto-persisted by `@workflow/world-local` (FS-backed) and exposed via `run.getReadable({startIndex})`. That's the durable transcript.

When something needs ModelMessages or UIMessages, it derives them from the chunk stream:
- `UIMessage[]` ← `readUIMessageStream({stream: run.getReadable({startIndex: 0})})` (AI SDK helper)
- `ModelMessage[]` ← reconstruct from UIMessages or read from inside the workflow's loop variable (each turn re-passes `result.messages` to the next iteration)

Custom data parts (`data-phone-action`, `data-signal-*`, `data-run-*`, `data-agent-sleep`) are also part of the same chunk stream — they're written by tools/hooks via `getWritable()`. No separate event file needed.

What this means: we have **one source of truth for the transcript** (Workflow SDK's persisted chunk stream) and a **few asset files** we manage ourselves (run.json, prompt.md, screenshots, signals).

### Loading historical data

Two reads cover every "load for later" use case:

| API | Use case | Source |
|---|---|---|
| `GET /runs/{id}/stream?startIndex=0` (SSE) | Replay everything (live or completed) | `run.getReadable({startIndex: 0})` → `createUIMessageStreamResponse` |
| `GET /runs/{id}/messages` | Get UIMessages for non-streaming consumers | `readUIMessageStream({stream: run.getReadable({startIndex: 0})})` collected to array |

Workflow SDK's stream is fully durable — replays are bit-identical to the original (no lossy text-delta collapse). Late subscribers and live tailers both go through the same `getReadable()`; the only difference is `startIndex` (0 = from start; omitted = live tail; positive = from that chunk; negative = last N chunks).

### Workflow body & live SSE

The whole agent loop is one workflow function. Everything is `getWritable()` writes:

```ts
// src/orchestrator/src/agents/durable-loop.ts
import { getWritable, sleep } from 'workflow'
import type { UIMessageChunk } from 'ai'

export async function leadAgentWorkflow(args: { runId: string, accountId: string, team: string, prompt?: string }) {
  "use workflow"

  // Step boundary — bootstrap can do IO
  const ctx = await loadContextStep(args)   // loads team config, account env, prompt snapshot path

  // Get the run's writable; chunks pushed here are persisted by Workflow SDK
  // and exposed via run.readable
  const writable = await getWritable<UIMessageChunk>()

  // Lifecycle marker
  await writable.getWriter().write({
    type: 'data-run-started',
    id: ulidStep(),
    data: { run_id: args.runId, account: args.accountId, team: args.team, model: ctx.model, prompt_snapshot_path: ctx.promptPath, initial_prompt: args.prompt ?? null }
  })

  // Continuation loop — each turn is itself a step (idempotent + retried)
  let messages = ctx.initialMessages
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stepResult = await runAgentTurnStep({ runId: args.runId, messages, ctx, writable })
    messages = stepResult.messages
    if (stepResult.terminate) break
  }

  // Final lifecycle marker
  await writable.getWriter().write({
    type: 'data-run-completed',
    id: ulidStep(),
    data: { run_id: args.runId, final_text: lastAssistantText(messages), turn_count: messages.length }
  })
}

// One turn = one step (deterministic from inputs; retryable)
async function runAgentTurnStep(p) {
  "use step"
  const writable = p.writable
  const result = await p.ctx.agent.stream({
    messages: p.messages,
    // pipe AI SDK chunks straight into the durable stream
    writable: pipeChunks(writable),
    preventClose: true,
  })
  await persistMetadataStep(p.runId, /* not the messages — Workflow SDK already has the chunks */)
  return { messages: result.messages, terminate: !result.willContinue }
}
```

The HTTP route just exposes the run's readable:

```ts
// src/orchestrator/src/server/routes/runs.ts
import { start } from 'workflow'
import { createUIMessageStreamResponse } from 'ai'

app.post('/api/v1/runs', async (c) => {
  const body = await c.req.json()
  const runId = ulid()
  const run = await start(leadAgentWorkflow, [{ runId, accountId: body.account, team: body.team, prompt: body.prompt }])

  // Persist run.json, prompt snapshot, etc (our metadata)
  await runStore.create({ id: runId, workflowRunId: run.runId, account: body.account, ... })

  return c.json({ runId, workflowRunId: run.runId })
})

app.get('/api/v1/runs/:id/stream', async (c) => {
  const startIndex = c.req.query('startIndex') ? Number(c.req.query('startIndex')) : 0
  const run = await getRun(c.req.param('id'))                              // resolve workflowRunId
  const readable = run.getReadable({ startIndex })                          // resumable!
  const tailIndex = await readable.getTailIndex()
  return createUIMessageStreamResponse({
    stream: readable,
    headers: {
      'x-workflow-run-id': run.runId,
      'x-workflow-stream-tail-index': String(tailIndex),
    },
  })
})
```

Replay is **free** — same endpoint serves live tail and historical replay. `startIndex` is the chunk index (0 = from start, negative = from end, positive = from that point).

### Posterity events from inside tools

Tools that need to emit `data-*` events (auto-screenshot, signal flow) get the writable from inside their step:

```ts
// src/orchestrator/src/sandbox/hooks/emit-posterity.ts
async function emitPhoneAction(payload, runId) {
  "use step"
  const writable = await getWritable<UIMessageChunk>()
  await writable.getWriter().write({ type: 'data-phone-action', id: ulid(), data: payload })
  // No separate persistence — Workflow SDK already saved this chunk
}
```

### Approvals via `hook()` + `resumeHook()`

The escalate / approval flow is the section-7 pattern from the original design doc:

```ts
// src/orchestrator/src/agents/tools/escalate.ts (called from inside the workflow)
import { hook, resumeHook } from 'workflow'

export async function requestApproval(args, runId) {
  // Deterministic token — derived from runId + tool_call_id (replay-safe)
  const token = `approval:${runId}:${args.toolCallId}`
  const h = hook<{ decision: 'approve' | 'reject' | 'skip' }>()

  // Step persists the signal (idempotent: read-then-write keyed by token)
  await persistSignalStep({ token, runId, ...args })

  // Emit data-signal-created to the stream
  const writable = await getWritable()
  await writable.getWriter().write({ type: 'data-signal-created', id: ulid(), data: { ... } })

  // SUSPEND. Workflow SDK durably waits here.
  const result = await h.create({ token })

  // Emit data-signal-resolved
  await writable.getWriter().write({ type: 'data-signal-resolved', id: ulid(), data: result })
  return result.decision
}

// HTTP route resumes the hook:
// src/orchestrator/src/server/routes/signals.ts
app.post('/api/v1/signals/:id/resolve', async (c) => {
  "use step"  // Note: route handler steps wrap resumeHook
  const body = await c.req.json()
  const signal = await signalStore.get(c.req.param('id'))
  await resumeHook(signal.hookToken, { decision: body.decision })
  await signalStore.markResolved(signal.id, body.decision, body.message)
  return c.json({ ok: true })
})
```

The workflow body is suspended **durably** — the orchestrator can restart, redeploy, etc, and the run picks up where it left off when `resumeHook` is called.

### What we persist ourselves

| File | Owner | Purpose |
|---|---|---|
| `runs/{id}/run.json` | Us | Run metadata: account, team, agentRole, model, status, workflowRunId, timestamps |
| `runs/{id}/prompt.md` | Us | Snapshot of system prompt (immutable per run) |
| `runs/{id}/traces/{tcid}/{before,annotated,after}.png` | Us | Screenshots referenced by `data-phone-action` chunks via URL |
| `runs/{id}/traces/{tcid}/result.json` | Us | Raw bash result (stdout/stderr/exit) — referenced by URL |
| `runs/{id}/signals/{sigid}.json` | Us | Approval state (ties our signal id to the workflow hook token) |
| `accounts/{id}/{account.json,credentials.json,env/}` | Us | Account environment |
| `teams/{name}/...` | Us | Team config + prompt files |
| `index/runs.jsonl` | Us | Fast list index |
| **The chunk stream itself** | **Workflow SDK** | All UIMessageChunks (text-delta, tool-call, tool-result, data-*) — auto-persisted via @workflow/world-local |

We don't store ModelMessages or UIMessages explicitly. If a downstream needs the conversation transcript, it reads the chunk stream via `run.getReadable({startIndex: 0})` and pipes it through AI SDK's `readUIMessageStream` to get UIMessages. That's the answer to "what about UIMessages from DurableAgent?": we don't store them — they're a derived view of the persisted chunk stream.

## Streaming architecture (use AI SDK protocol + custom data parts)

AI SDK v5 already has a battle-tested streaming protocol over SSE: `UIMessageChunk` types like `text-delta`, `tool-call`, `tool-input-delta`, `tool-result`, `start`, `finish`, plus first-class **custom data parts** (`data-{name}`) that the framework reconciles by ID. We use this protocol directly instead of inventing our own envelope, which means downstream consumers (and any future React UI we add) can use AI SDK helpers like `readUIMessageStream` for free.

The current code already hands AI SDK a `WritableStream<UIMessageChunk>` (`durable-agent.ts:241`), so we're just teeing what's already there + injecting custom `data-*` chunks for our posterity events.

### Wire format (SSE)

Every event over SSE is a JSON-serializable `UIMessageChunk`. Our event surface falls into three buckets:

**Bucket 1 — Forwarded from AI SDK** (no transformation, just re-emit):
- Lifecycle: `start`, `start-step`, `finish-step`, `finish`
- Text: `text-start`, `text-delta`, `text-end`
- Reasoning: `reasoning-start`, `reasoning-delta`, `reasoning-end`
- Tool args: `tool-input-start`, `tool-input-delta`, `tool-input-end`
- Tool execution: `tool-call`, `tool-result`

**Bucket 2 — Custom data parts (`data-*`)** — our posterity events injected into the same stream:

| Type                   | When                          | Payload                                                                                   |
| ---------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `data-run-started`     | Run begins                    | `{run_id, account, team, agent_role, model, prompt_snapshot_path, initial_prompt}`        |
| `data-run-completed`   | Final assistant message       | `{run_id, final_text, turn_count}`                                                        |
| `data-run-failed`      | Unrecoverable error           | `{run_id, error}`                                                                         |
| `data-run-cancelled`   | User cancelled                | `{run_id}`                                                                                |
| `data-phone-action`    | An `otacon` command ran       | see below — keeps both command AND result                                                 |
| `data-signal-created`  | Approval/escalation requested | `{signal_id, kind, command?, rationale?, screenshot_path?}`                               |
| `data-signal-resolved` | User answered                 | `{signal_id, decision, message?}`                                                         |
| `data-agent-sleep`     | `sleep_until` tool            | `{phase: 'started' \| 'ended', until?, reason?, started_at?}`                             |

**Bucket 3 — Internal `data-*` events** (still wire-framed as `data-*`, but the frontend's renderer allowlist filters them out):
- `data-meta-prompt-snapshot` — emitted once at run start with the snapshot path so debug consumers can correlate
- `data-meta-turn` — `{turn_index, agent_role}` at the start of each loop iteration
- `data-meta-error` — non-fatal warnings (e.g. trace write failure) for debugging

These are emitted through `getWritable<UIMessageChunk>()` like any other chunk and persisted by Workflow SDK, but the web UI's known-types list doesn't include them, so they're silently hidden. The CLI also hides them by default; `--debug` shows them.

### Timestamps & event identity

AI SDK's `UIMessageChunk` doesn't carry timestamps natively, but we don't need to extend the protocol — we get them for free in two places:

1. **Chunk `id` field**: every chunk we emit sets `id` to a **ULID** (monotonic, sortable, encodes ms timestamp in its first 48 bits). Any consumer decodes the prefix to get the timestamp without a separate field.
2. **Our posterity events** (`data-*` types we control): include `ts` directly in the `data` payload. Already shown in the `data-phone-action` schema (`started_at`, `completed_at`).

Frontend code decodes the ULID once in a shared helper (`tsFromUlid(chunkId)`) and uses it everywhere.

### `data-phone-action` payload (keeps command AND result together)

```json
{
  "type": "data-phone-action",
  "id": "01J9...",
  "data": {
    "tool_call_id": "abc",
    "command": "otacon tap e5",
    "subcommand": "tap",
    "target": "e5",
    "rationale": "open search",
    "started_at": 1714000001000,
    "completed_at": 1714000001312,
    "exit_code": 0,
    "stdout": "(no output)",
    "stderr": "",
    "screenshots": {
      "before":    "/api/v1/runs/{run_id}/traces/abc/before.png",
      "annotated": "/api/v1/runs/{run_id}/traces/abc/annotated.png",
      "after":     "/api/v1/runs/{run_id}/traces/abc/after.png"
    }
  }
}
```

Both the command AND its result live in the single `data-phone-action` event for inspection. The underlying AI SDK `tool-call`/`tool-result` for the `bash` tool are also forwarded — they're the model-level view; this is the phone-action-level view enriched with screenshots. The UI shows them folded together when one exists for the same `tool_call_id`.

### Why both live + posterity in the same stream

Workflow SDK persists every chunk pushed via `getWritable<UIMessageChunk>()`. The same `run.getReadable({startIndex})` serves both live tail (omitted index) and historical replay (`startIndex: 0` for full, positive int for resume from a known position, negative for last-N). Disconnect/reconnect is handled by the client passing the last seen tail-index back as `?startIndex=`.

### In-process pipeline

```
DurableAgent.stream({writable})
       │
       ▼
WritableStream<UIMessageChunk>  ←  AI SDK chunks
       │  (writable obtained from getWritable() inside the workflow turn step)
       ▼
Workflow SDK persists chunks via @workflow/world-local
       │
       ▼
run.readable / run.getReadable({startIndex})
       │
       ├──►  GET /runs/{id}/stream    (live tail or replay; `createUIMessageStreamResponse`)
       └──►  GET /runs/{id}/messages  (collected via `readUIMessageStream`)


Custom posterity events take the same path:
       writable.getWriter().write({ type: 'data-phone-action', id: ulid(), data: {...} })
```

Single sink (the workflow's writable). Single source of truth (Workflow SDK's persisted chunk stream). Callers can't accidentally emit-without-persist or persist-without-emit because Workflow SDK always does both.

### CLI client behavior

CLI uses `fetch` with streaming response body, parses SSE lines, exits on a terminal `data-run-*` event. Renders chunks as:
- `text-delta` → write to stdout
- `tool-call` → `[tool] bash(...)`
- `data-phone-action` → `[phone] otacon tap e5 → exit 0` plus the URL to the annotated screenshot
- `data-signal-created` → `[approval needed] otacon tap e5 — open search` plus URL to screenshot. Pauses the print loop and prompts inline (or polls for resolution if running headless with `--auto-approve` / `--no-prompt`).
- `data-run-completed` → final text, exit 0
- `data-run-failed` → error, exit 1
- `data-run-cancelled` → exit 2

## Auto-screenshot wrapper

We wrap the `otacon` custom command in just-bash (`src/orchestrator/src/sandbox/build.ts`). Pseudo:

```typescript
defineCommand('otacon', async (args, ctx) => {
  const subcmd = args[0]                          // tap, swipe, set-text, screenshot, info, ...
  const isPhoneAction = MUTATING_PHONE_CMDS.has(subcmd)  // tap, long-tap, swipe, set-text, type, key, app launch/stop, open

  const traceDir = ctx.env.OTACON_TRACE_DIR
  let beforePath: string | null = null
  let annotatedPath: string | null = null
  let afterPath: string | null = null

  if (isPhoneAction) {
    // 1. Snapshot first to know element bounds (refs are about to change)
    const snapshot = await client.snapshot('json')

    // 2. Capture the BEFORE screenshot
    beforePath = `${traceDir}/before.png`
    await client.screenshotTo(beforePath)

    // 3. Render annotated overlay
    annotatedPath = `${traceDir}/annotated.png`
    await annotateAction(beforePath, annotatedPath, subcmd, args, snapshot)
  }

  // 4. Run the actual command
  const result = await runOtacon(args)

  // 5. Capture AFTER screenshot
  if (isPhoneAction) {
    afterPath = `${traceDir}/after.png`
    await client.screenshotTo(afterPath)
  }

  // 6. Emit posterity event with all paths
  emitEvent({
    type: 'phone.action',
    payload: {
      command: args.join(' '),
      target: parseTarget(subcmd, args, snapshot),  // ref or coords
      before_path: beforePath,
      annotated_path: annotatedPath,
      after_path: afterPath,
      exit_code: result.exitCode,
    },
  })

  return result
})
```

### Annotation rendering (`annotateAction`)

Uses `sharp` (already in deps). Per action:
- **tap / long-tap**: read the ref from args, look up bounds in snapshot, draw a colored circle (red for tap, orange for long-tap) at the bounds center, sized to the bounds dimensions
- **swipe**: draw an arrow from `(x1,y1)` to `(x2,y2)`, with a small dot at start and arrowhead at end
- **set-text / type**: draw a rectangle around the input field's bounds, plus a label text-overlay at the corner with the truncated value
- **app launch / stop**: no overlay needed (no on-screen target); the screenshot itself is the record
- **key**: text label "KEY: home" overlaid at top-right

Sharp can composite SVG over the PNG — we generate small SVG strings per shape. No need for a full image library.

### Caveats

- Some `otacon` commands aren't actions (info, snapshot, screenshot, sms list, etc) — skip the wrapper, no extra screenshots
- The before-screenshot adds \~200ms latency per action. Acceptable given the agent thinks much longer
- For the current sleep/dozing screen, the before-screenshot will look the same as the after — that's fine; the annotation tells the story
- The wrapper takes screenshots via the same `OtaconClient` the agent uses; no extra Pi roundtrip beyond the existing `info` snapshot most actions already do

## Prompt snapshotting

`buildSystemPrompt` (`src/orchestrator/src/agents/build-prompt.ts`) currently renders at runtime from team files + tool reference. We change one thing:

```typescript
// At run start, in run-executor.ts:
const promptText = await buildSystemPrompt(team, account, /* runtime tools */ )
const promptSnapshotPath = `runs/${runId}/prompt.md`
await fs.writeFile(promptSnapshotPath, promptText)

// Use promptText for the agent's `instructions` field — same content, but now also persisted
```

Result: `runs/{id}/prompt.md` is the exact prompt the model saw. Old runs always show the right prompt regardless of code/template changes.

The web UI shows "View prompt" → fetches `runs/{id}/prompt.md` via the API. **No template viewer page** — there's nothing to view across runs because every run has its own snapshot.

## Approvals via Web UI (and CLI)

Today, mutating commands trigger `requestApproval` (`src/orchestrator/src/approval/prompt.ts`) which blocks on stdin or filesystem polling. New flow uses **Workflow SDK's `hook()` for durable suspension**:

1. Agent's bash tool detects mutating command → calls `approval-bridge.requestApproval(...)` from inside the workflow.
2. The bridge creates a deterministic hook token (`approval:${runId}:${toolCallId}`), writes `runs/{id}/signals/{signalId}.json` with `{id, kind, command, rationale, screenshot_path, createdAt, hookToken}`, and emits a `data-signal-created` chunk into the run's stream.
3. The bridge calls `await hook.create({ token })`. **The workflow durably suspends** — the orchestrator can restart, redeploy, etc. without losing the run.
4. UI fetches `GET /api/v1/signals?status=pending` (or watches the run's stream for `data-signal-created`), shows the approval panel with the annotated screenshot, command, rationale, and Approve/Reject/Skip buttons.
5. User clicks → `POST /api/v1/signals/{id}/resolve {decision}` → server reads the hook token from `SignalStore`, calls `resumeHook(token, {decision})` from inside a step, then `signalStore.markResolved(...)`. Workflow SDK delivers the value to the suspended workflow, which resumes from the saved state.
6. Bridge emits a `data-signal-resolved` chunk, returns the decision. Agent resumes with the decision.

CLI parity: `orchestrator signals list` / `orchestrator signals resolve <id> approve [--message ...]` — for headless ops or when the UI isn't open.

The current "open the screenshot in Preview before approving" UX (file-based prompt) becomes "the screenshot is right there in the UI."

## HTTP API

All under `/api/v1/`. JSON request/response except SSE.

### Runs

| Method | Path                                      | Description                                                                                          |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| POST   | `/runs`                                   | Start a run. Body: `{account, team?, prompt?}`. Calls `start(leadAgentWorkflow, ...)`. Returns `{runId, workflowRunId}`. |
| GET    | `/runs`                                   | List runs. Query: `?account=&status=&limit=&beforeId=`. Reads from `index/runs.jsonl`.               |
| GET    | `/runs/{id}`                              | Run detail (metadata only). Reads `runs/{id}/run.json`.                                              |
| GET    | `/runs/{id}/prompt`                       | Returns the snapshotted system prompt as plaintext.                                                  |
| GET    | `/runs/{id}/stream`                       | SSE stream of UIMessageChunks. Optional `?startIndex={n}` (Workflow-SDK chunk index; `0` = from start, negative = from end, omitted = live tail). Wraps `run.getReadable({startIndex})` with `createUIMessageStreamResponse`. Returns headers `x-workflow-run-id` + `x-workflow-stream-tail-index`. |
| GET    | `/runs/{id}/messages`                     | Full conversation as `UIMessage[]`. Internally: pipes `run.getReadable({startIndex: 0})` through `readUIMessageStream`, returns the array. |
| GET    | `/runs/{id}/traces/{tool_call_id}/{file}` | Serve a trace file (e.g. annotated.png) from `runs/{id}/traces/`.                                    |
| POST   | `/runs/{id}/cancel`                       | Stop the run via Workflow SDK cancel.                                                                |
| POST   | `/runs/{id}/messages`                     | Send user message to running run. Resumes a `userMessage` hook on the workflow.                      |

### Accounts

| Method | Path                        | Description                                                                                                                 |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/accounts`                 | Create account. Body: `{id, displayName?, phoneNumber?, email?}`. Writes `accounts/{id}/account.json` + `credentials.json`. |
| GET    | `/accounts`                 | List. Walks `accounts/*/account.json`.                                                                                      |
| GET    | `/accounts/{id}`            | Detail.                                                                                                                     |
| GET    | `/accounts/{id}/env/{path}` | Read environment file (persona.md etc).                                                                                     |
| PUT    | `/accounts/{id}/env/{path}` | Update environment file (overwrite).                                                                                        |

### Teams

| Method | Path            | Description                            |
| ------ | --------------- | -------------------------------------- |
| GET    | `/teams`        | List teams. Walks `teams/*/team.json`. |
| GET    | `/teams/{name}` | Team config.                           |

### Signals (approvals + escalations)

| Method | Path                      | Description                                                             |
| ------ | ------------------------- | ----------------------------------------------------------------------- |
| GET    | `/signals?status=pending` | List pending across runs.                                               |
| GET    | `/signals?run_id={id}`    | Per-run signals.                                                        |
| POST   | `/signals/{id}/resolve`   | Resolve. Body: `{decision: "approve" \| "reject" \| "skip", message?}`. |

### Health / static

| Method | Path                     | Description                           |
| ------ | ------------------------ | ------------------------------------- |
| GET    | `/health`                | `{ok: true}`.                         |
| GET    | `/api/docs/openapi.json` | OpenAPI spec via `@hono/zod-openapi`. |
| GET    | `/`                      | Web UI entry point.                   |
| GET    | `/static/*`              | UI static assets.                     |

### SSE event format

Wire framing is whatever AI SDK's `createUIMessageStreamResponse` produces — we do not serialize SSE manually. Each `data:` payload is a `UIMessageChunk` JSON object. Concretely:

```
data: {"type":"data-run-started","id":"01J9WV1","data":{"run_id":"01J9WV...","account":"xhs:test","team":"social-media-engagement","agent_role":"engagement-lead","model":"qwen3.6-plus","prompt_snapshot_path":"/api/v1/runs/01J9WV.../prompt","initial_prompt":"..."}}

data: {"type":"text-delta","id":"01J9WV2","textDelta":"Looking at the home feed..."}

data: {"type":"tool-call","toolCallId":"abc","toolName":"bash","input":{"command":"otacon tap e5","rationale":"open search"}}

data: {"type":"data-phone-action","id":"01J9WV4","data":{"tool_call_id":"abc","command":"otacon tap e5","target":"e5","screenshots":{"before":"/api/v1/runs/.../traces/abc/before.png","annotated":"/api/v1/runs/.../traces/abc/annotated.png","after":"/api/v1/runs/.../traces/abc/after.png"},"exit_code":0,"started_at":1714000001000,"completed_at":1714000001312}}

data: {"type":"tool-result","toolCallId":"abc","toolName":"bash","output":"(no output)"}

data: {"type":"data-run-completed","id":"01J9WV6","data":{"run_id":"01J9WV...","final_text":"Posted the spring lookbook successfully.","turn_count":12}}
```

Terminal chunk types: `data-run-completed`, `data-run-failed`, `data-run-cancelled`. CLI exits on these. Response also carries `x-workflow-run-id` and `x-workflow-stream-tail-index` headers from the wrapper, used by clients to reconnect with `?startIndex=`.

## CLI redesign

Becomes a thin HTTP client:

```bash
orchestrator agent run --account xhs:test [--team ...] [--prompt "..."]
  → POST /api/v1/runs → get {runId}
  → GET /api/v1/runs/{id}/stream (SSE) → render UIMessageChunks to stdout
  → exit on terminal event (0=completed, 1=failed, 2=cancelled)

orchestrator runs list                    → GET /api/v1/runs
orchestrator runs show <runId>            → GET /api/v1/runs/{id} + paginated events
orchestrator runs prompt <runId>          → GET /api/v1/runs/{id}/prompt (plaintext to stdout)
orchestrator runs cancel <runId>          → POST /api/v1/runs/{id}/cancel
orchestrator runs message <runId> "<txt>" → POST /api/v1/runs/{id}/messages

orchestrator signals list                 → GET /api/v1/signals?status=pending
orchestrator signals show <id>            → GET /api/v1/signals/{id} (returns paths to screenshots, prints summary)
orchestrator signals resolve <id> approve → POST /api/v1/signals/{id}/resolve

orchestrator service add-account ...      → POST /api/v1/accounts
```

CLI config at `~/.orchestrator/config.toml`:
```toml
url = "https://otacon-orchestrator.<tailnet>.ts.net:9090"
token = "..."  # placeholder, not enforced yet
```
Env: `ORCHESTRATOR_URL`, `ORCHESTRATOR_TOKEN`.

## Web UI

Static SPA at `src/orchestrator/static/`, served by Hono. Two main pages:

### `/` — Runs list

Table of runs (read from `index/runs.jsonl` via API). Filters: account, team, status, date range. Columns: id, team, account, status, started, duration, initial prompt (truncated). Click a row → `/run?id={runId}`.

### `/run?id={runId}` — Run detail / timeline

What you actually see when loading a completed run page:

```
┌────────────────────────────────────────────────────────────────────┐
│  ← Back to runs                                                    │
│                                                                    │
│  Run 01J9WV1F8K…                                       [completed] │
│  ──────────────────────────────────────────────────────────────── │
│  Account:  xhs:test                                                │
│  Team:     social-media-engagement                                 │
│  Agent:    engagement-lead                                         │
│  Model:    alibaba/qwen3.6-plus                                    │
│  Started:  2026-04-23 09:12:34   Duration: 3m 42s                  │
│  Initial prompt: "Open Chrome, search for 'cats'…"                 │
│  [📄 View prompt snapshot]                                         │
│                                                                    │
│  Filters: ☑ Text  ☑ Tool calls  ☑ Phone actions  ☐ Reasoning       │
│           ☑ Approvals  ☑ Lifecycle  ☐ Debug/meta                   │
│  ──────────────────────────────────────────────────────────────── │
│                                                                    │
│  Timeline                                                          │
│                                                                    │
│  09:12:34   ●  Run started                                         │
│             Initial prompt: "Open Chrome, search for 'cats'…"      │
│                                                                    │
│  09:12:35   💬 engagement-lead · qwen3.6-plus                      │
│             I'll start by waking the phone and opening Chrome.     │
│                                                                    │
│  09:12:36   🔧 bash                              ▾ expand          │
│             rationale: Wake the phone                              │
│             $ otacon key wake                                      │
│             exit 0  (no output)                                    │
│                                                                    │
│  09:12:38   📱 tap → e103 (Home)                 ▾ expand          │
│             ┌──────┐ ┌──────┐ ┌──────┐                            │
│             │before│ │annot.│ │after │   (click any to enlarge)   │
│             └──────┘ └──────┘ └──────┘                            │
│             $ otacon tap e103                                      │
│             rationale: Tap home to dismiss any overlay             │
│             exit 0  (no output)                                    │
│                                                                    │
│  09:12:42   📱 app launch → com.android.chrome   ▾                │
│             ┌──────┐ ┌──────┐  (no annotation — package launch)   │
│             │before│ │after │                                     │
│             └──────┘ └──────┘                                     │
│             exit 0                                                 │
│                                                                    │
│  09:12:50   💬 engagement-lead · qwen3.6-plus                      │
│             Chrome is open. Now I need to tap the address bar…     │
│                                                                    │
│  09:13:02   ⚠️  Approval requested                                 │
│             ┌──────────────────────────────────────────────────┐   │
│             │  [annotated screenshot, ~280px wide]              │   │
│             │  Command:   otacon set-text e6 "cats"             │   │
│             │  Rationale: Type the search query                 │   │
│             │                                                   │   │
│             │      [ Approve ]  [ Reject ]  [ Skip ]            │   │
│             └──────────────────────────────────────────────────┘   │
│                                                                    │
│  09:13:08   ✓ Approval resolved — approved                         │
│                                                                    │
│  09:13:09   📱 set-text → e6                     ▾                 │
│             ┌──────┐ ┌──────┐ ┌──────┐                            │
│             │before│ │annot.│ │after │  ← annot shows boxed field │
│             └──────┘ └──────┘ └──────┘                            │
│                                                                    │
│  09:13:12   📱 key → enter                                         │
│                                                                    │
│  09:13:18   💬 engagement-lead · qwen3.6-plus                      │
│             Search results loaded. Scrolling once…                 │
│                                                                    │
│  09:13:20   📱 swipe → (540,1500)→(540,500)      ▾                │
│             [annot shows arrow from start to end]                  │
│                                                                    │
│  09:16:16   ●  Run completed                                       │
│             "Successfully searched 'cats' and scrolled once."      │
│             8 turns                                                │
└────────────────────────────────────────────────────────────────────┘
```

Behaviors:
- **Header**: pulls from `run.json`. The "View prompt snapshot" button opens `prompt.md` (this run's snapshot) in a modal — guaranteed to be the prompt that was actually used.
- **Filter bar**: checkboxes hide/show event categories. Defaults shown above. State persisted in localStorage.
- **Timeline** (single-track, vertical, oldest first): each entry is a card or one-liner.
  - `💬` agent text — full text in a styled block with `agent_role` + `model` badge in the corner
  - `🔧` bash tool call — collapsed by default; expand shows command, rationale, exit code, full stdout/stderr
  - `📱` phone action — three thumbnails (before / annotated / after); click for full-size; expand shows command + rationale. The matching `🔧 bash` for the same `tool_call_id` is folded INTO this card so you don't see it twice.
  - `⚠️` approval requested — large card with the annotated screenshot + Approve/Reject/Skip buttons. Buttons disabled if already resolved (and `✓ Approval resolved` line shows below).
  - `✓` approval resolved — one-liner showing the decision
  - `🌙` sleep — one-liner "slept 5m 12s"
  - `●` lifecycle markers — run started / completed / failed / cancelled
- **Live tail**: when status is `running`, the page opens an `EventSource` to `/runs/{id}/stream` (no startIndex — server defaults to live tail). Auto-scroll-to-bottom unless the user has scrolled up.
- **Loading a completed run**: same page, opens `/runs/{id}/stream?startIndex=0` and reads to EOF; renders the full timeline at once. The browser also fetches `/runs/{id}/messages` for any UI bits that need finalized UIMessages (e.g. the prompt-context viewer). Screenshots referenced by URL (`/runs/{id}/traces/{tcid}/{file}`) lazy-load on scroll.
- **Click-to-enlarge** screenshots: opens in a modal with prev/next navigation across the run.

Pages built with vanilla HTML/JS/CSS. Pattern matches `src/registry/static/`. Uses the browser's native `EventSource` for live and `fetch` for static loads. No bundler, no framework.

## Deployment

### Docker image

`Dockerfile.orchestrator` (multi-stage, Node 22):
- Build: `pnpm install`, `pnpm --filter otacon-orchestrator build`
- Final: `node --no-warnings dist/index.js serve`
- Exposes port 9090
- Mount: `/data/orchestrator/` → `ORCHESTRATOR_DATA_DIR`

### docker-compose.orchestrator.yml

```yaml
services:
  tailscale-orchestrator:
    image: tailscale/tailscale:latest
    hostname: otacon-orchestrator
    environment:
      - TS_AUTHKEY=${TS_AUTH_KEY_ORCHESTRATOR}
      - TS_STATE_DIR=/var/lib/tailscale
    volumes:
      - tailscale-orchestrator-state:/var/lib/tailscale

  orchestrator:
    image: ghcr.io/thisnick/otacon/orchestrator:latest
    network_mode: service:tailscale-orchestrator
    environment:
      - ORCHESTRATOR_DATA_DIR=/data/orchestrator
      - OTACON_REGISTRY_URL=http://otacon-registry.<tailnet>.ts.net:9080
      - OTACON_TOKEN=${OTACON_TOKEN}
      - AI_GATEWAY_API_KEY=${AI_GATEWAY_API_KEY}
    volumes:
      - orchestrator-data:/data/orchestrator
    depends_on:
      - tailscale-orchestrator

  watchtower:
    image: containrrr/watchtower
    environment:
      - DOCKER_API_VERSION=1.40
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock

volumes:
  tailscale-orchestrator-state:
  orchestrator-data:
```

Same Tailscale-sidecar + Watchtower pattern as the registry stack.

### VPS provisioning via OpenTofu (repurposed from `openclaw-yingjiang/infra/`)

Provisioning lives at `tofu/` in this repo. Drop-in adapt of the existing OCI Free-Tier pattern: ARM Ampere (`VM.Standard.A1.Flex`), 2 OCPU / 12GB RAM / 50GB boot, Ubuntu 24.04, with cloud-init handling first-boot setup and Tailscale enrollment. State is encrypted in-repo (`pbkdf2` + `aes_gcm`) using `TF_VAR_encryption_passphrase`.

Files (mirrors `../openclaw-yingjiang/infra/`):
- `tofu/main.tf` — OCI provider, VCN+IGW+route+SL (only Tailscale UDP/41641 ingress + all egress), subnet, compute instance with cloud-init metadata. Display name `otacon-orchestrator`.
- `tofu/variables.tf` — `encryption_passphrase`, `tenancy_ocid`, `user_ocid`, `fingerprint`, `private_key`/`private_key_path`, `region`, `compartment_ocid`, `tailscale_auth_key`, `tailnet_domain` (default `tail0437b8.ts.net`), `extra_ssh_public_keys`.
- `tofu/outputs.tf` — `instance_public_ip`, `ssh_private_key` (sensitive), `instance_id`.
- `tofu/cloud-init.yaml` — first-boot script (see below).
- `tofu/terraform.tfstate{,.backup}` — encrypted, committed to repo.

#### `tofu/cloud-init.yaml`

```yaml
#cloud-config
hostname: ${hostname}
manage_etc_hosts: true
package_update: true
package_upgrade: true
packages:
  - ca-certificates
  - curl
  - gnupg

write_files:
  - path: /opt/orchestrator/.env
    permissions: '0600'
    content: |
      OTACON_REPO=otacon
      ORCHESTRATOR_DATA_DIR=/data/orchestrator
      OTACON_REGISTRY_URL=https://otacon-registry.${tailnet_domain}:9080
      OTACON_TOKEN=${otacon_token}
      AI_GATEWAY_API_KEY=${ai_gateway_api_key}
      TS_AUTH_KEY_ORCHESTRATOR=${tailscale_auth_key}
  - path: /opt/orchestrator/docker-compose.yml
    content: |
      ${docker_compose_yaml}

runcmd:
  # Tailscale
  - curl -fsSL https://tailscale.com/install.sh | sh
  - tailscale up --ssh --hostname=${hostname} --authkey=${tailscale_auth_key}

  # Docker
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  - echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

  # GHCR auth (read-only) so private orchestrator image can pull
  - echo "${ghcr_pull_token}" | docker login ghcr.io -u thisnick --password-stdin

  # Bring up the stack — Watchtower handles updates from there
  - cd /opt/orchestrator && docker compose pull && docker compose up -d
```

The compose YAML is rendered by `templatefile()` from `docker-compose.orchestrator.yml`. The file uses **the existing `TS_AUTH_KEY_REGISTRY`** locally for both Terraform's Tailscale enrollment and the Tailscale sidecar inside docker-compose — same key, two consumers.

#### Required `.env` for `tofu apply` (these come from `../openclaw-yingjiang/.env`)

The OCI vars exist already in your openclaw `.env`. Same Oracle tenancy → same vars work here:

```
TF_VAR_encryption_passphrase=...     # reuse the openclaw passphrase
TF_VAR_tenancy_ocid=ocid1.tenancy.oc1...
TF_VAR_user_ocid=ocid1.user.oc1...
TF_VAR_fingerprint=...
TF_VAR_region=us-sanjose-1
TF_VAR_compartment_ocid=...
TF_VAR_private_key_path=/Users/nick/code/openclaw-yingjiang/wiseyu@gmail.com-2026-03-13T20_28_29.238Z.pem
TF_VAR_tailscale_auth_key=$TS_AUTH_KEY_REGISTRY
TF_VAR_tailnet_domain=tail0437b8.ts.net
```

A small bootstrap step in the Makefile sources the openclaw `.env` to fill OCI fields and substitutes the local `TS_AUTH_KEY_REGISTRY`. This avoids duplicating credentials.

#### Apply path

`tofu apply` runs **locally** for now — no GitHub Actions workflow. Whoever runs it commits the updated encrypted state files (`terraform.tfstate{,.backup}`) back to `main`. State is safe to commit because it's encrypted at rest with `TF_VAR_encryption_passphrase`.

If we ever want CI-driven applies later, mirror `../openclaw-yingjiang/.github/workflows/terraform.yml`.

### Makefile additions

```makefile
ORCHESTRATOR_HOST ?= otacon-orchestrator.tail0437b8.ts.net
ORCHESTRATOR_USER ?= ubuntu

orchestrator-build:
	docker buildx build -f Dockerfile.orchestrator -t ghcr.io/thisnick/otacon/orchestrator:latest --push .

orchestrator-tofu-init:
	cd tofu && tofu init

orchestrator-tofu-plan:
	cd tofu && tofu plan -out=tfplan

orchestrator-tofu-apply:
	cd tofu && tofu apply tfplan

orchestrator-push: orchestrator-build
	# Watchtower auto-pulls on the VPS

orchestrator-logs:
	ssh $(ORCHESTRATOR_USER)@$(ORCHESTRATOR_HOST) "docker logs -f --tail=200 orchestrator"

orchestrator-restart:
	ssh $(ORCHESTRATOR_USER)@$(ORCHESTRATOR_HOST) "cd /opt/orchestrator && docker compose restart orchestrator"
```

## Implementation phases

### Phase 1 — File-based backend + Workflow SDK adoption

**Goal**: orchestrator runs locally with pure FS for our metadata, no Neon, no SQLite. The agent loop is wrapped in a Workflow SDK workflow using `@workflow/world-local` for chunk-stream persistence. Existing CLI behavior unchanged for end users.

> **Decision (2026-04-29):** P1 adopts **Nitro** (`workflow/nitro` module) as the build pipeline. The `"use workflow"` and `"use step"` directives are SWC-plugin transforms and only run via Nitro. Pulls server scaffolding forward from P3 — but Phase 3's remaining work is unaffected (Nitro provides routing, not the API surface). Smoke verified end-to-end (`tests/orchestrator/e2e/test-workflow-smoke.ts` — 12/12 passing).
>
> **API corrections discovered while wiring:**
> - `setWorld(...)` is exported from `@workflow/core/runtime`, not `workflow/api`.
> - The hook helper is `createHook<T>(opts)`, not `hook<T>()`. Typed wrapper is `defineHook<I,O>({schema?})`. Both exported from `workflow`.
> - **Stream writes (`getWritable().getWriter().write(...)`) MUST happen inside `"use step"` functions, not in the workflow body.** The workflow body runs in a deterministic VM where `WritableStream.getWriter()` is unavailable. The plan's earlier sketches that wrote chunks directly from the workflow body (e.g. lifecycle markers) need to be wrapped in step boundaries. See `foundations/streaming.mdx` and the smoke test for the canonical pattern.
> - Nitro plugins default-export an async function: `export default async function () { ... }` — no `defineNitroPlugin` import.

> **Load-bearing patterns (don't violate without testing):**
>
> 1. **Hook ordering inside a tool's execute (NO `'use step'`):** `createHook({token})` first → persist signal + emit `data-signal-created` (step) → `await hook`. If you emit the chunk before `createHook` runs, an external resolver can race the chunk and POST `/signals/:id/resolve` before `world-local` indexes the token, hitting `HookNotFoundError`. References: `workflows/lead-agent.ts` (bash + escalate tools), `workflows/approval-flow.ts`, `src/run-executor/approval-bridge.ts` (TSDoc on `approvalHook`).
> 2. **Stream writes only inside `'use step'` functions.** The workflow body runs in a deterministic VM where `WritableStream.getWriter()` throws `ENOTSUP`. Every `getWritable().getWriter().write(...)` must live in a step. The workflow body just `await`s those steps in order.

Changes:
- **Drop**: `@neondatabase/serverless`, `drizzle-orm`, `drizzle-kit` from `package.json`. Remove `src/orchestrator/src/db/`.
- **Configure**: `@workflow/world-local` as the workflow store, pointed at `${ORCHESTRATOR_DATA_DIR}/workflow/`. (Already a dep — just wire it up at startup.)
- **Add**: Nitro setup — `nitro.config.ts` with `modules: ['workflow/nitro']`, `serverDir: 'server'`, `scanDirs: ['workflows']`. Server source moves to `server/{routes,plugins}/`. Workflow bodies live in `workflows/`. Add `dev` (= `nitro dev`) and `build:server` scripts. Pulls minimum-viable HTTP server (single `POST /api/v1/runs` route + `GET /api/v1/runs/:id/stream` + signal-resolve route for CLI approval) forward from P3; the rest of P3's HTTP surface stays in P3.
- **Add**: `src/orchestrator/src/storage/{account-store,team-store,run-store,signal-store}.ts` — interfaces + FS-backed implementations. `RunStore` only handles metadata (run.json, prompt.md, status); chunk stream lives in Workflow SDK storage.
- **Add**: `src/orchestrator/src/storage/blob-store.ts` — rename `LocalBlobStore` → `BlobStoreFs`; add `putScreenshot`/`getScreenshot`/`putToolResult`/`getToolResult` helpers; preserve existing `put`/`get`/`list` API.
- **Add**: `src/orchestrator/src/storage/index-store.ts` — append-only JSONL writer + scan/dedupe reader for `index/runs.jsonl` and `index/by-account|by-status/*.jsonl`.
- **Add**: `src/orchestrator/src/agents/durable-loop.ts` — wraps the existing agent loop in `"use workflow"`, with each turn as `"use step"`. Uses `getWritable<UIMessageChunk>()` to push chunks into the run's stream.
- **Modify (folded into above)**: `src/orchestrator/src/workflows/durable-agent.ts` and `team-runner.ts` are deleted; their bodies move into `agents/durable-loop.ts` and `run-executor/index.ts`. The `agent.stream({ writable, ... })` call now writes to the Workflow SDK writable.
- **Modify**: `src/orchestrator/src/cli/inspect.ts` — read run.json from `RunStore`; reconstruct conversation by piping `run.getReadable({startIndex: 0})` through `readUIMessageStream`.
- **Modify**: `src/orchestrator/src/cli/add-account.ts` — write `accounts/{id}/account.json` + `credentials.json` + bootstrap `env/` files.
- **Modify**: `src/orchestrator/src/approval/prompt.ts` — replace stdin loop with `hook<Decision>()` + persisting the hook token via `SignalStore`. Phase 1 still resolves the hook from a CLI prompt (the HTTP signal route comes in Phase 3).
- **Add**: `scripts/rebuild-index.ts` — walks `runs/*/run.json` and rewrites `index/`.
- **Modify**: `.env.example` — drop `DATABASE_URL`, add `ORCHESTRATOR_DATA_DIR`.

**Verification (end-to-end against a real phone — phone-3)**:

1. **Bootstrap**: delete any old `.orchestrator-data/`. Run `pnpm orchestrator service add-account --id xhs:test --phone-number +12136961477`. Confirm `accounts/xhs:test/{account.json,credentials.json,env/{persona.md,soul.md,agents.md},workspace/}` exist.
2. **Real agent scenario** — *"open Chrome, search for cats, scroll once"*:
   ```
   pnpm orchestrator agent run --account xhs:test --team social-media-engagement \
     --prompt "Open Chrome, search for 'cats', and scroll down once. Then exit."
   ```
   Phase 1 wraps the agent in a workflow but still resolves approvals via CLI prompt (the HTTP path arrives in Phase 3).
3. **Verify run dir**: `runs/{id}/run.json` has `status: "completed"`, `model`, `team`, `agentRole`, a non-empty `promptSnapshotPath`, and a non-null `workflowRunId`.
4. **Verify prompt snapshot**: `runs/{id}/prompt.md` contains the actual system prompt text (account name + tools reference).
5. **Verify chunk stream persisted by Workflow SDK**: `${ORCHESTRATOR_DATA_DIR}/workflow/` contains a directory matching the run's `workflowRunId`, non-empty.
6. **Verify replay produces the conversation**: a small script that calls `workflow.run(workflowRunId).getReadable({startIndex: 0})` and feeds it into `readUIMessageStream` returns a non-empty `UIMessage[]` ending in an assistant message with the final text.
7. **Verify traces**: `runs/{id}/traces/{any_tool_call}/result.json` exists.
8. **Verify index**: `cat .orchestrator-data/index/runs.jsonl | jq '.status'` ends with `"completed"`. `pnpm orchestrator runs list` (new CLI subcommand) returns the run.
9. **Integration test runner**: a script `tests/orchestrator/e2e/phase1-chrome-search.ts` that scripts steps 2–8 with assertions, runnable via `pnpm test:e2e:phase1`. Skipped in CI; documented as "requires phone-3 connected to the registry".

### Phase 2 — Auto-screenshot wrapper + posterity events

**Goal**: every phone action auto-captures before/annotated/after; events emitted to FS.

Changes:
- **Modify**: `src/orchestrator/src/sandbox/build.ts` — wrap `defineCommand('otacon', ...)` to do the before/annotated/after dance for mutating subcommands.
- **Add**: `src/orchestrator/src/sandbox/annotate.ts` — sharp-based overlay renderer (tap circle, swipe arrow, text label, box).
- **Add**: `src/orchestrator/src/run-executor/posterity-events.ts` — typed `data-*` chunk builders + a thin wrapper around `getWritable<UIMessageChunk>()` so tools/hooks can emit posterity chunks from inside their step.
- **Add**: `src/orchestrator/src/sandbox/hooks/auto-screenshot.ts` and `emit-posterity.ts` — capture before/annotated/after screenshots via `BlobStore.putScreenshot`, then emit `data-phone-action` through the writable.

**Verification (end-to-end against phone-3)**:

1. **Real agent scenario** — same as Phase 1 but expecting screenshots: *"Open Chrome, tap the address bar, type 'cats site:wikipedia.org', enter, then scroll down once."* This deliberately exercises tap, set-text, key, and swipe annotations.
   ```
   pnpm orchestrator agent run --account xhs:test --team social-media-engagement \
     --prompt "Open Chrome, tap the address bar, type 'cats site:wikipedia.org', press enter, then scroll down once."
   ```
2. **Verify per-action artifacts**: for each phone-action `tool_call_id` under `runs/{id}/traces/`:
   - `before.png` exists and is a valid PNG
   - `annotated.png` exists and visually differs from `before.png` (image-diff hash check)
   - `after.png` exists and visually differs from `before.png` (page changed)
3. **Verify annotation correctness**:
   - For the address-bar tap: `annotated.png` has a circle overlay near the bounds the snapshot reported for the tapped ref
   - For the scroll: `annotated.png` has an arrow from start coords to end coords
4. **Verify chunk stream contains the posterity event**: replay the run via `workflow.run(workflowRunId).getReadable({startIndex: 0})` and assert at least one chunk per phone action with `type: 'data-phone-action'` and a `data` payload containing `command`, `subcommand`, `target`, `rationale`, `tool_call_id`, `screenshots.{before,annotated,after}` (URLs into `/runs/{id}/traces/...`), `exit_code`, `stdout`, `stderr`, `started_at`, `completed_at`.
5. **Verify the bash `tool-call`/`tool-result` chunks are also present** in the same chunk stream — the phone-action event is additive, not a replacement.
6. **Integration test runner**: `tests/orchestrator/e2e/phase2-chrome-actions.ts` scripts the run and assertions. Includes a tiny PNG validator (`sharp` metadata check) and the visual-diff hash. Runnable via `pnpm test:e2e:phase2`. Documented as requiring phone-3.

### Phase 3 — HTTP API + SSE streaming

**Goal**: orchestrator is a server. CLI is a client. SSE wire framing comes from AI SDK; durability + replay come from Workflow SDK.

> **Note (2026-04-29):** The server itself + Workflow SDK adoption + minimum-viable routes (`POST /runs`, `GET /runs/:id/stream`, `POST /signals/:id/resolve`) landed in **P1** as part of the Nitro adoption decision. Phase 3 now covers the *rest* of the HTTP API surface, the polished CLI subcommand client, and OpenAPI generation. Hono is replaced by Nitro/h3 (Nitro's underlying server). No `serve` subcommand needed — `pnpm dev` runs `nitro dev` directly.

Changes:
- **Add**: Remaining route handlers in `server/routes/` — accounts (POST/GET/env file CRUD), teams list/detail, runs list/show/cancel/messages/prompt/traces, signals list, health, OpenAPI spec.
- **Modify (already in P1)**: ~~`src/orchestrator/src/server/index.ts` — Hono entry; `serve` subcommand in `src/orchestrator/src/index.ts`.~~ Server is Nitro-based; landed in P1.
- **Add**: `src/orchestrator/src/run-executor/index.ts` — public API `startRun()`, `cancelRun()`, `sendUserMessage()`. Each calls into Workflow SDK (`start()`, cancel, `resumeHook` for the user-message hook). No in-memory event bus: live tail and historical replay both go through `run.getReadable()`.
- **Modify**: `src/orchestrator/src/run-executor/approval-bridge.ts` — `POST /signals/:id/resolve` looks up the hook token from `SignalStore`, calls `resumeHook(token, decision)` from inside a step, and marks the signal resolved.
- **Rewrite**: `src/orchestrator/src/cli/commands/run.ts` — POST a run, open `EventSource` against `/runs/{id}/stream`, render UIMessageChunks, block on terminal `data-run-*` chunk.
- **Add**: `src/orchestrator/src/cli/commands/{runs-list,runs-show,runs-cancel,runs-message,runs-prompt,signals-list,signals-resolve}.ts`.
- **Add**: `src/orchestrator/src/config.ts` — TOML config + env, similar to `src/cli/src/config.ts`.
- **Add to `package.json`**: `hono`, `@hono/node-server`, `@hono/zod-openapi`, `eventsource` (Node SSE client).

**Verification (end-to-end against phone-3)**:

1. **Server up**: `pnpm orchestrator serve` listens on `:9090`. `curl http://localhost:9090/health` returns `{ok:true}`. `curl http://localhost:9090/api/v1/runs` returns the runs from prior phases.
2. **Streaming run** — same Chrome scenario, this time through HTTP+SSE:
   ```
   pnpm orchestrator agent run --account xhs:test --team social-media-engagement \
     --prompt "Open Chrome, navigate to wikipedia.org, scroll down once."
   ```
   The CLI must print `data-run-started`, several `tool-call`+`data-phone-action`+`tool-result` triples interleaved with `text-delta`, and finally `data-run-completed` before exiting 0.
3. **Resumable replay via Workflow SDK**: while the run is mid-flight, in another shell `curl -N http://localhost:9090/api/v1/runs/{id}/stream` should stream remaining events (live tail). Note the `x-workflow-stream-tail-index` response header. Disconnect, reconnect with `?startIndex=<that index>` — replay picks up after the disconnect, no duplicates, no gaps. Also verify `?startIndex=0` on a completed run replays the entire transcript bit-identical to the live observation.
4. **Web-UI-driven approval (durable suspension)**: trigger a mutating-command scenario by adding `--require-approval` to the test prompt:
   ```
   pnpm orchestrator agent run --account xhs:test --team social-media-engagement --require-approval \
     --prompt "Open Chrome and tap the first article link on wikipedia.org."
   ```
   - CLI prints `[approval needed] otacon tap eN — open the first article` and pauses
   - In another shell: `pnpm orchestrator signals list` shows the pending signal
   - **Restart the server** (`Ctrl-C` and re-run `pnpm orchestrator serve`) — the workflow stays suspended via Workflow SDK's hook
   - `pnpm orchestrator signals resolve {id} approve` calls `resumeHook` and the run resumes from the saved state, completing successfully
5. **Cancellation**: kick off a longer prompt (e.g. "browse the home feed for 30 seconds"), then `pnpm orchestrator runs cancel {id}`. CLI exits 2; `runs/{id}/run.json` shows `status: "cancelled"`; final chunk in the stream is `data-run-cancelled`.
6. **Integration test runner**: `tests/orchestrator/e2e/phase3-streaming.ts` covers steps 2–5 with assertions on chunk order and HTTP responses. Runnable via `pnpm test:e2e:phase3`. Requires phone-3 + the `serve` process running locally.

### Phase 4 — Web UI

**Goal**: browser at the orchestrator URL shows runs, timeline, approvals.

Changes:
- **Add**: `src/orchestrator/static/index.html` — runs list.
- **Add**: `src/orchestrator/static/run.html` — timeline + live SSE + approval buttons.
- **Add**: `src/orchestrator/static/app.js`, `style.css`.
- **Modify**: Hono server serves `static/` at `/static` and `index.html` at `/`.

**Verification (end-to-end against phone-3, with browser)**:

1. **Static load**: open `http://localhost:9090/`. Page lists prior runs (Phase 1–3 runs from `index/runs.jsonl`). Click a completed run → timeline renders with screenshots inline. Filters hide/show event types correctly.
2. **Live streaming UI**: with `/run?id={newRunId}` open in browser, kick off:
   ```
   pnpm orchestrator agent run --account xhs:test --team social-media-engagement \
     --prompt "Open Chrome, navigate to wikipedia.org, scroll down once."
   ```
   The browser updates live: text-deltas append to the assistant text block; tool-calls and `data-phone-action` events appear as new cards; screenshots load as the actions complete.
3. **Approval-from-UI scenario**: kick off:
   ```
   pnpm orchestrator agent run --account xhs:test --team social-media-engagement --require-approval \
     --prompt "Open Chrome, search 'cats', open the first result, scroll once."
   ```
   - CLI blocks awaiting approval
   - Browser timeline shows a `data-signal-created` card with annotated screenshot, command, rationale, and Approve/Reject/Skip buttons
   - Click **Approve** in browser → POST to `/api/v1/signals/{id}/resolve` → CLI resumes → run completes
   - `data-signal-resolved` card appears with `decision: "approve"`
4. **Prompt snapshot view**: from a completed run page, click "View prompt" → full system prompt (from that run's `prompt.md`) renders in a modal/new tab.
5. **Verify nothing in UI requires CLI parity gaps**: run the same flow purely via browser (start a run via a "New run" button → browse → approve → see completion). Every action visible in UI is also doable via CLI (this is the `/teams` `POST /runs` API parity check).
6. **Integration test runner**: `tests/orchestrator/e2e/phase4-ui.ts` uses Playwright (already a known-good agent automation tool here) to drive the browser through scenarios 2 and 3. Asserts DOM updates against the SSE stream.

### Phase 5 — VPS deploy via OpenTofu (repurposed from `openclaw-yingjiang`)

**Goal**: production runs on an OCI Free Tier ARM VPS provisioned via OpenTofu, with first-boot setup handled entirely by cloud-init. Tailscale is the only ingress; Watchtower handles image rollouts.

Changes:
- **Add**: `Dockerfile.orchestrator` (multi-stage Node 22, port 9090, mount `/data/orchestrator`).
- **Add**: `docker-compose.orchestrator.yml` (Tailscale sidecar + orchestrator + Watchtower; same pattern as registry).
- **Add**: `tofu/` directory (drop-in adaptation of `../openclaw-yingjiang/infra/`):
  - `tofu/main.tf`, `tofu/variables.tf`, `tofu/outputs.tf`, `tofu/cloud-init.yaml`
  - hostname `otacon-orchestrator`, OCI `VM.Standard.A1.Flex` 2 OCPU / 12GB / 50GB
  - cloud-init writes `/opt/orchestrator/.env` + `docker-compose.yml`, installs Docker + Tailscale, `docker compose up -d`
  - reuses `TS_AUTH_KEY_REGISTRY` from local `.env` as the Tailscale auth key
- **Add**: `tofu/.envrc.example` — `direnv` template that re-exports `TF_VAR_*` from `../openclaw-yingjiang/.env` and the local otacon `.env`. No new credential storage.
- **Modify**: `Makefile` — `orchestrator-build`, `orchestrator-tofu-{init,plan,apply}`, `orchestrator-{push,logs,restart}`.
- **Modify**: `.env.example` — `OTACON_TOKEN`, `AI_GATEWAY_API_KEY`, `GHCR_PULL_TOKEN` (note: OCI vars live in `../openclaw-yingjiang/.env`, sourced via direnv).
- **Modify**: `AGENTS.md` — orchestrator deployment note.

**Verification (end-to-end against the deployed VPS + phone-3)**:

1. **`tofu apply` succeeds**: from the dev laptop, `make orchestrator-tofu-init && make orchestrator-tofu-plan && make orchestrator-tofu-apply`. Outputs include `instance_public_ip` and a non-empty `ssh_private_key`.
2. **VPS is on the tailnet**: `tailscale status | grep otacon-orchestrator` shows the new node `Online`. SSH via `ssh ubuntu@otacon-orchestrator.tail0437b8.ts.net` (using the Tailscale SSH path enabled in cloud-init).
3. **Cloud-init completed**: `ssh ... "docker ps"` shows `tailscale-orchestrator`, `orchestrator`, and `watchtower` containers all `Up`.
4. **Health from anywhere on tailnet**: `curl https://otacon-orchestrator.tail0437b8.ts.net:9090/health` → `{ok:true}`.
5. **State persisted across container restarts**: `make orchestrator-restart`, `https://.../api/v1/runs` still returns prior runs (confirms `/data/orchestrator` volume mount).
6. **Real cross-network agent run** — orchestrator on VPS, phone on Pi, dev laptop drives the CLI:
   ```
   ORCHESTRATOR_URL=https://otacon-orchestrator.tail0437b8.ts.net:9090 \
     pnpm orchestrator agent run --account xhs:test --team social-media-engagement \
     --prompt "Open Chrome, navigate to wikipedia.org, scroll down once."
   ```
   Same Phase 3 happy-path scenario, but the orchestrator is on the VPS reaching the Pi over Tailscale. Must complete without networking errors.
7. **Browser from off-VPS machine**: open `https://otacon-orchestrator.tail0437b8.ts.net:9090/` from the dev laptop. Run from step 6 appears in the list with all events + screenshots.
8. **Watchtower auto-deploy**: change a UI string locally → `make orchestrator-push` → wait ~60s → reload browser → string updated, no SSH or manual restart.
9. **Re-apply is idempotent**: `make orchestrator-tofu-plan` after step 8 reports "No changes." (cloud-init has `lifecycle { ignore_changes = [metadata] }` on the instance).
10. **Integration test runner**: `tests/orchestrator/e2e/phase5-vps.ts` runs steps 6–7 against `ORCHESTRATOR_URL` set to the VPS. Documented as the production-parity smoke test.

## Source file structure

The orchestrator splits cleanly into **server**, **agent**, **sandbox**, **storage**, and **client (CLI + UI)**. From experience the AI SDK agent loop gets complicated, so each concern gets its own subdirectory with a single entry point.

### Tree

```
src/orchestrator/
  package.json
  src/
    index.ts                          # commander entry; dispatches to cli/* OR boots server
    config.ts                         # ~/.orchestrator/config.toml + ORCHESTRATOR_* env

    # ────────── HTTP server ──────────
    server/
      index.ts                        # Hono app, route mounting, port 9090
      middleware/
        error.ts                      # JSON error envelope
        logging.ts                    # request logging
        auth.ts                       # bearer-token stub (no enforcement yet)
      routes/
        runs.ts                       # POST/GET /runs, /runs/:id, cancel, messages
        runs-stream.ts                # GET /runs/:id/stream — wraps run.getReadable({startIndex}) in createUIMessageStreamResponse
        runs-messages.ts              # GET /runs/:id/messages — derives UIMessage[] via readUIMessageStream
        runs-traces.ts                # GET /runs/:id/traces/:tcid/:file (serve trace bytes)
        accounts.ts                   # POST/GET /accounts, env file CRUD
        teams.ts                      # GET /teams, /teams/:name
        signals.ts                    # GET /signals, POST /signals/:id/resolve (calls resumeHook)
        health.ts                     # /health

    # ────────── Run executor (Workflow SDK adapter + lifecycle glue) ──────────
    run-executor/
      index.ts                        # public API: startRun() → workflow.start; cancelRun(); sendUserMessage() (resumes a userMessage hook)
      posterity-events.ts             # data-run-started, data-phone-action, data-signal-* chunk builders + getWritable() helpers
      approval-bridge.ts              # workflow-side: hook<Decision>() + persist token via SignalStore. HTTP-side: lookup token + resumeHook
      prompt-snapshotter.ts           # render system prompt once + writePromptSnapshot()

    # ────────── Agent loop (workflow body) ──────────
    agents/
      durable-loop.ts                 # `"use workflow"` continuation loop; each turn = `"use step"`. Calls getWritable<UIMessageChunk>().
      build-agent.ts                  # DurableAgent factory given team + executor handle
      build-prompt.ts                 # existing — assembles system prompt
      tools/
        bash.ts                       # bash tool definition (calls sandbox.exec, emits posterity)
        sleep-until.ts                # sleep_until tool — uses workflow `sleep()` for durable wait
        escalate.ts                   # escalate tool — calls approval-bridge.requestApproval (hook + resumeHook pattern)
      tool-handlers/
        phone-action-parser.ts        # parses "otacon tap eN" args + snapshot → target
        phone-action-emitter.ts       # builds the data-phone-action chunk payload

    # ────────── Sandbox (just-bash + otacon dispatch + auto-screenshots) ──────────
    sandbox/
      build.ts                        # buildSandbox(); composes commands + hooks
      annotate.ts                     # sharp-based overlay (tap circle, swipe arrow, etc)
      parsers.ts                      # isMutatingPhoneCmd, parsePhoneTarget
      commands/
        otacon.ts                     # defineCommand('otacon') dispatcher
        otacon-alloc.ts               # phone lease commands
      hooks/
        auto-screenshot.ts            # wraps otacon execution: before/annotated/after
        emit-posterity.ts             # after-action hook that calls run-executor.posterity-events

    # ────────── Storage (FS-backed; chunk stream lives in Workflow SDK, not here) ──────────
    storage/
      types.ts                        # Run, Signal, Account, Team types
      factory.ts                      # makeStores(dataDir): { accountStore, teamStore, runStore, blobStore, signalStore }
      account-store.ts                # interface + AccountStoreFs class
      team-store.ts                   # interface + TeamStoreFs class
      run-store.ts                    # interface + RunStoreFs class (run.json + prompt.md + index only — no chunks)
      blob-store.ts                   # interface + BlobStoreFs class (renamed from LocalBlobStore; adds putScreenshot/putToolResult helpers)
      signal-store.ts                 # interface + SignalStoreFs class (signal_id ↔ workflow hook token mapping)
      index-store.ts                  # append-only JSONL writer + scan/dedupe reader for index/
      paths.ts                        # path layout constants (runs/, traces/, signals/, etc)
      ulid.ts                         # ULID generation + tsFromUlid helper

    # ────────── Workflow SDK wiring ──────────
    workflow/
      world.ts                        # configures @workflow/world-local at ${ORCHESTRATOR_DATA_DIR}/workflow/
      index.ts                        # re-exports helpers (typed start, getRun, etc)

    # ────────── CLI client ──────────
    cli/
      index.ts                        # commander wiring (called by src/index.ts)
      client.ts                       # OrchestratorClient: typed fetch + SSE wrapper
      commands/
        run.ts                        # `agent run` — POST /runs, tail SSE, render
        runs-list.ts                  # `runs list`
        runs-show.ts                  # `runs show`
        runs-cancel.ts                # `runs cancel`
        runs-message.ts               # `runs message`
        runs-prompt.ts                # `runs prompt` (cat snapshot)
        signals-list.ts
        signals-resolve.ts
        accounts-add.ts               # `service add-account` — POST /accounts
        accounts-list.ts
        teams-list.ts
        serve.ts                      # `serve` — boots Hono via server/index.ts
      render/
        sse-renderer.ts               # parses SSE chunks → renderable events
        text-renderer.ts              # accumulates text-delta into clean stdout
        tool-renderer.ts              # formats tool-call / tool-result
        phone-action-renderer.ts      # formats data-phone-action with screenshot URL
        signal-renderer.ts            # formats approvals + interactive prompt
        run-list-table.ts             # table renderer for `runs list`

  static/                             # web UI (vanilla HTML/JS/CSS)
    index.html                        # runs list page
    run.html                          # timeline page
    app.js                            # shared API client + event renderer
    sse.js                            # browser EventSource wrapper
    style.css

  scripts/
    rebuild-index.ts                  # walk runs/*/run.json → rewrite index/*

  tests/
    unit/                             # pure unit tests (parsers, annotate logic, etc)
    e2e/
      README.md                       # how to run, hardware required (phone-3 connected)
      phase1-chrome-search.ts
      phase2-chrome-actions.ts
      phase3-streaming.ts
      phase4-ui.ts
      phase5-vps.ts
      helpers/
        run-and-tail.ts               # spawn CLI run, collect events
        screenshot-validate.ts        # PNG validity + visual-diff hash
        playwright-driver.ts          # browser automation for phase4
```

### Files to modify (in current code)

**Modify:**
- `package.json` — drop `@neondatabase/serverless`, `drizzle-orm`, `drizzle-kit`. Add `hono`, `@hono/node-server`, `@hono/zod-openapi`, `eventsource`. (`sharp` and `ulid` are already there.)
- `src/index.ts` — restructure to dispatch into `cli/index.ts`; add `serve` command.
- (Files below are effectively rewritten and split into the new tree above)

**Create:** entire tree above.

**Delete:**
- `src/db/` directory (schema, client, migrate, migrations).
- `drizzle.config.ts`.
- Standalone `src/workflows/durable-agent.ts` and `src/workflows/team-runner.ts` — their content moves into `agents/durable-loop.ts` and `run-executor/index.ts`.
- Standalone `src/storage/conversation.ts` — its API folds into `run-store-fs.ts`.
- Standalone `src/approval/prompt.ts` — replaced by `run-executor/approval-bridge.ts`.

### Repo root

**Modify:**
- `Makefile` — orchestrator targets
- `AGENTS.md` — orchestrator deployment note
- `.env.example` — orchestrator vars

**Create:**
- `Dockerfile.orchestrator`
- `docker-compose.orchestrator.yml`
- `tofu/{main.tf,variables.tf,outputs.tf,cloud-init.yaml,.envrc.example}` — drop-in adaptation of `../openclaw-yingjiang/infra/*`
- `tofu/terraform.tfstate{,.backup}` — encrypted state, committed to repo (manual `tofu apply` locally, then `git commit && git push origin main`)

## Critical reuse

- **`runDurableAgent` body** (`src/orchestrator/src/workflows/durable-agent.ts:70-280`) — body kept; refactored into `agents/durable-loop.ts` and wrapped in `"use workflow"` with each turn as `"use step"`. The AI SDK `agent.stream({ writable, ... })` call is unchanged — its writable is now the workflow's `getWritable<UIMessageChunk>()`.
- **`LocalBlobStore`** (`src/orchestrator/src/storage/blob.ts`) — reused, renamed `BlobStoreFs`; specialized helpers added on top of the existing `put`/`get`/`list`.
- **`buildSandbox` + `defineCommand('otacon')`** (`src/orchestrator/src/sandbox/build.ts`) — kept; we wrap the otacon dispatch to add auto-screenshots and emit `data-phone-action` chunks.
- **`buildSystemPrompt`** (`src/orchestrator/src/agents/build-prompt.ts`) — kept; called once at run start, output snapshotted to `runs/{id}/prompt.md`.
- **`requestApproval`** signature (`src/orchestrator/src/approval/prompt.ts`) — kept; implementation rewritten to use Workflow SDK's `hook()` + `resumeHook()`.
- **AI SDK `WritableStream<UIMessageChunk>`** flow (durable-agent.ts:241-257) — kept; the writable is now obtained from `getWritable<UIMessageChunk>()` so chunks land in Workflow SDK's persisted stream.
- **Workflow SDK already in deps** (`workflow`, `@workflow/ai`, `@workflow/world-local` in `package.json`) — no new dep, just wire it up at startup.
- **Tailscale sidecar pattern** (`docker-compose.registry.yml`) — copied for orchestrator.
- **Ansible `bootstrap` + `tailscale` roles** — reused for VPS provisioning.
- **Static UI pattern** (`src/registry/static/`) — copied verbatim for orchestrator UI.

## Out of scope

- Multi-team / sub-agents (lead → operator → producer fan-out via `start()` from inside the workflow): the design doc covers it; not in this redesign.
- `world-vercel` / cross-serverless durability: we run in a single VPS process — `world-local` is sufficient.
- React UI / `WorkflowChatTransport` / `useChat`: vanilla HTML/JS UI consumes the SSE directly; we can adopt these later if we move to React.
- Authentication on the HTTP API: token field in config is reserved but not enforced. The orchestrator is reachable only over Tailscale.
- Migration of existing Neon data: drop, don't migrate (exploratory runs).
- Conversation compaction: future; the per-agent `summary.md` slot is reserved.
- S3-compatible blob storage: filesystem only.
