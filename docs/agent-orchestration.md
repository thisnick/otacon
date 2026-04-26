# Agent Orchestration Platform — Design Spec

This document describes the design of the agent orchestration layer that sits on top of otacon. It is intended to give a coding agent (or human engineer) enough context to start implementing without reading external chat history.

## 1. Context and goals

otacon is a phone-fleet automation system: a Pi host runs `otacon-server` which controls Android phones via ADB, and a CLI/admin layer drives it. This is the **execution substrate**.

We are building an **orchestration platform** on top that:

- Runs autonomous AI agents that operate social media accounts on the phones.
- Supports multiple users, each owning multiple accounts.
- Enables campaign-driven content production at scale (e.g. one campaign producing varied content for 100 accounts).
- Provides reflection and analysis loops so accounts learn and improve over time.
- Models agency-style team structures (lead, operator, content production, reflection — and shared brand-level analysts) to balance per-account voice with cross-account learning.
- Runs locally during development and trivially deploys to Vercel for production.

## 2. Tech stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Agent loop | **AI SDK v7** (`ai` package, `WorkflowAgent` from `@ai-sdk/workflow`) | Industry standard (~12M weekly downloads), multi-model via Vercel AI Gateway, built-in approval flow, integrates natively with Workflow SDK. |
| Durable orchestration | **Vercel Workflow SDK** (`workflow` package) | Durable execution with `sleep()` and `hook()` primitives, world-adapter system makes local + Vercel deployment trivial, composes natively with AI SDK via `WorkflowAgent`. |
| Sandbox / execution env | **just-bash** (`vercel-labs/just-bash`) | TS-implemented bash with `MountableFs`, `defineCommand` for in-process custom tools, no VM provisioning needed. We don't need Firecracker — our "untrusted code" is our own LLM driving our own commands. |
| Database | **Neon Postgres** | Serverless, branching for dev environments, same schema everywhere. |
| Blob storage | **Vercel Blob** (production) / **MinIO or local FS** (development) | S3-compatible. Backs both shared content (brand strategies, campaigns) and per-account workspaces. |
| Local dev | Workflow SDK `@workflow/world-local` | File-backed durable state. Same code runs in cloud by swapping to `@workflow/world-vercel`. |
| Relay | Reverse proxy (Caddy) on a Tailscale-attached VPS | The orchestrator runs in the cloud and needs to reach the Pi over Tailscale. The relay terminates TLS, enforces auth, and forwards over Tailscale. |

### Why not Pi (`pi-mono`)?

Pi has a clean, minimal agent loop and well-documented context compaction. We initially considered it, but **DurableAgent / WorkflowAgent only wrap AI SDK primitives** — there's no Pi adapter. Since durable execution is load-bearing for our use case, we go with AI SDK and port Pi's compaction approach via `prepareStep`.

### Why not Open Agents directly?

Open Agents is Vercel's reference coding-agent template. It uses Firecracker microVMs because a coding agent needs real `node`, `git`, dev servers, preview URLs. We don't — our tools are in-process via `defineCommand`. We borrow ideas (durable workflows, hook-based human-in-the-loop) but skip the microVM layer.

## 3. High-level architecture

```
                    ┌─────────────────────────────┐
                    │ Public Internet              │
                    └──────────────┬──────────────┘
                                   │ HTTPS + bearer / mTLS
                    ┌──────────────▼──────────────┐
                    │ Relay VPS (Tailscale node)   │
                    │ - TLS termination            │
                    │ - Auth                       │
                    │ - Routes to phone hosts      │
                    └──────────────┬──────────────┘
                                   │ Tailscale private
                    ┌──────────────▼──────────────┐
                    │ Pi Host (otacon-server)      │
                    └─────────────────────────────┘

─────────────────────────────────────────────────────────

                    ┌─────────────────────────────┐
                    │ Orchestrator                 │
                    │ (Vercel cloud OR local CLI)  │
                    │                              │
                    │ Workflow SDK runtime         │
                    │ - world-local (dev)          │
                    │ - world-vercel (prod)        │
                    │                              │
                    │ Triggers:                    │
                    │ - HTTP webhooks              │
                    │ - Cron (Vercel cron config)  │
                    │ - CLI                        │
                    └──────────┬──────────────────┘
                               │ start() / resumeHook()
                ┌──────────────┼──────────────────────────┐
                ▼              ▼                          ▼
       ┌──────────────┐ ┌──────────────┐         ┌──────────────┐
       │ Account-     │ │ Campaign-    │         │ Brand-       │
       │ scoped       │ │ scoped       │         │ scoped       │
       │ workflows    │ │ workflows    │         │ workflows    │
       │              │ │              │         │              │
       │ Lead agent   │ │ Content      │         │ Brand        │
       │ Operator     │ │ Director     │         │ Reflector    │
       │ Per-account  │ │              │         │ Brand        │
       │ Producer     │ │              │         │ Competitive  │
       │ Per-account  │ │              │         │ Analyst      │
       │ Reflector    │ │              │         │              │
       └──────┬───────┘ └──────┬───────┘         └──────┬───────┘
              │                │                        │
              └────────────────┴────────────────────────┘
                                │
                       Shared state (Postgres + Blob)
```

## 4. Agent roster

Multiple agent types run at different scopes. This mirrors how real social media agencies structure teams: strategic/analytical roles work at higher scopes (brand, campaign), executional/personality-driven roles work per-account.

### Per-account agents (scope = `account`)

**Lead Agent** (1:1 per account)
- Long-running workflow, the account's "brain"
- Conversation persists across the account's lifetime, compacts at high threshold (~200K tokens)
- Orchestrates the per-account sub-agents
- Receives notifications, escalations, and user instructions
- Decides when to invoke each sub-agent

**Operator Agent** (1:1 per account, fresh context each invocation)
- IS the account — must be 1:1 to maintain consistent voice and behavior
- Posts content, replies to DMs/comments, follows/unfollows, browses
- Logs posts and engagements to DB
- Records competitor observations and trends to FS
- Stateless across runs; figures out current state by reading FS + DB

**Per-Account Content Producer** (1:1 per account, fresh context each invocation)
- Takes campaign-level materials and composition rules, produces account-specific posts
- Critical: ensures each account's content is unique combinations to avoid ban risk
- Tweaks copy, mixes/matches clips, adjusts visual style to fit the account's persona/audience
- Outputs to `/workspace/posts/`

**Per-Account Reflector** (1:1 per account, fresh context each invocation)
- Analyzes this account's engagement data
- Updates account-specific notes within campaign constraints
- Writes to `/workspace/reflection/`

### Per-campaign agents (scope = `campaign`)

**Campaign Content Director** (1 per campaign)
- Runs once during campaign setup, with the user
- Defines materials library, sample posts, mix-and-match composition rules
- Writes to `campaigns/{campaign_id}/` blob
- Long pause then completes when user approves

### Per-brand agents (scope = `brand_strategy`)

**Brand Reflector** (1 per brand strategy)
- Reads engagement across ALL accounts using this strategy
- Aggregates patterns visible only at scale ("UGC outperforms polished across 8/10 accounts")
- Reports to user via escalation; can suggest strategy or campaign updates
- Outputs to `brand_strategies/{id}/insights/`

**Brand Competitive Analyst** (1 per brand strategy)
- Aggregates `competitor_observations` table entries from all accounts using this brand
- Distributed surveillance: each operator logs observations during normal browsing — no single account suspiciously over-surveils
- Outputs to `brand_strategies/{id}/competitive/`

### Optional: matrix group agents (scope = `matrix_group`)

**Matrix Lead** (1 per group of 5–10 matrix accounts)
- Coordinates timing/behavior across supporting accounts to avoid pattern detection
- Staggers warm-up cadence, varies engagement patterns
- Replaces the per-account Lead for matrix accounts

## 5. Storage architecture

### What lives where

| Data | Storage | Why |
|------|---------|-----|
| Account metadata, credentials, agent_instances, campaigns, posts, engagements, escalations | Postgres | Queryable, indexed, transactional |
| DB-mounted files (persona.md, soul.md, agents.md) | Postgres `account_files` table with full version history | Tracked authorship and history; agents read via FS abstraction |
| Conversation messages + compaction seeds + summaries | Blob (`conversations/{id}/`) | Large, framework-managed; separated from agent workspace |
| Brand strategy contents | Blob (`brand_strategies/{id}/`) | User-flexible structure; mounted as RO into agents |
| Campaign contents (briefs, materials, composition rules) | Blob (`campaigns/{id}/`) | User-flexible structure; mounted as RO into agents |
| Per-account workspace (posts, reflection notes, trends) | Blob (`accounts/{id}/workspace/`) | Files agents create and modify |

### Per-account file system layout

This is what an agent sees after `MountableFs` is built:

```
/                                  -- ROOT, files loaded into system prompt at workflow start
  agents.md                        -- DB-mounted, RO. Hardcoded across all accounts.
                                      Describes the team and roles.
  persona.md                       -- DB-mounted, RO. User-defined per account.
  soul.md                          -- DB-mounted, RO. User-defined deeper personality.
  tools.md                         -- Generated at runtime, RO. Lists available tools.
  brand_strategies.md              -- Generated TOC, RO. Lists brand strategies with paths.
  campaigns.md                     -- Generated TOC, RO. Lists assigned campaigns with paths.

/brand_strategies/                 -- RO mount, only strategies linked to this account
  {strategy_id}/
    README.md                      -- TOC for this strategy
    voice.md                       -- arbitrary structure, user's choice
    icp.md
    guidelines.md
    examples/
      ...

/campaigns/                        -- RO mount, only campaigns assigned to this account
  {campaign_id}/
    README.md                      -- TOC
    brief.md
    composition_rules.md
    materials/
      hero-video.mp4
      bg-music.mp3
      copy-variants.md
    examples/
      ...

/workspace/                        -- ONLY writable area
  posts/                           -- Per-account final posts
    {date}-{slug}/
      content.md
      assets/
  materials/                       -- Per-account adapted/mixed materials
  trends/                          -- Operator's competitor observations
  reflection/                      -- Reflector's evolving notes
  scratch/                         -- Ad-hoc scratch
```

Mount sources mapped:

| Path | Source |
|------|--------|
| `/agents.md`, `/persona.md`, `/soul.md` | `account_files` table (DB-backed FS) |
| `/tools.md` | Generated at runtime |
| `/brand_strategies.md`, `/campaigns.md` | Generated TOC at runtime from DB queries |
| `/brand_strategies/{id}/` | Blob `brand_strategies/{id}/` (RO) |
| `/campaigns/{id}/` | Blob `campaigns/{id}/` (RO) |
| `/workspace/**` | Blob `accounts/{id}/workspace/` (RW) |

### Conversation storage

Conversations and compaction artifacts live in their own blob namespace, separate from agent workspaces:

```
conversations/{conversation_id}/
  messages/
    00001.json                     -- one file per message
    00002.json
    00003-image-a8f.png            -- referenced large artifacts
    ...
  compaction/
    seed-001.json                  -- the original messages that got compacted (the "seed")
    summary-001.md                 -- the compaction summary
    seed-002.json
    summary-002.md
```

DB tracks pointers only:

```sql
conversations (
  id PK, account_id FK, agent_role TEXT,
  blob_prefix TEXT,                -- "conversations/{id}/"
  current_summary_path TEXT,
  current_cutoff_seq INT,
  created_at, updated_at
)
```

The compaction "seed" is preserved (original messages) so we can re-summarize differently in the future.

## 6. Database schema

```sql
-- Users own everything
users (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
)

-- Accounts: managed social media accounts
accounts (
  id              TEXT PRIMARY KEY,         -- "xhs:littlered123"
  user_id         TEXT NOT NULL REFERENCES users(id),
  account_type    TEXT NOT NULL,            -- "xhs", "douyin", "wechat"
  role            TEXT NOT NULL DEFAULT 'main',  -- "main" | "matrix"
  matrix_group_id TEXT REFERENCES matrix_groups(id),  -- nullable
  display_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  config          JSONB DEFAULT '{}'        -- model preferences, etc
)

-- Credentials: flexible login methods (phone, email, oauth, ...)
account_credentials (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  credential_type TEXT NOT NULL,            -- "phone" | "email" | "whatsapp" | "google_oauth"
  identifier      TEXT NOT NULL,            -- phone number / email / oauth user id
  secrets         JSONB,                    -- encrypted: { password, totp_secret, oauth_tokens }
  is_primary      BOOLEAN DEFAULT false,
  verified        BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(credential_type, identifier)
)

-- Matrix groups: clusters of supporting accounts under shared coordination
matrix_groups (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  main_account_id TEXT NOT NULL REFERENCES accounts(id),
  name            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
)

-- Agent instances: tracks running workflows by scope and role
-- This is how we look up "is this agent already running?" before invoking
agent_instances (
  id              TEXT PRIMARY KEY,
  scope_type      TEXT NOT NULL,            -- "account" | "campaign" | "brand_strategy" | "matrix_group"
  scope_id        TEXT NOT NULL,            -- references the appropriate table
  agent_role      TEXT NOT NULL,
      -- account scope:    "lead" | "operator" | "content_producer" | "reflector"
      -- campaign scope:   "content_director"
      -- brand scope:      "brand_reflector" | "competitive_analyst"
      -- matrix scope:     "matrix_lead"
  workflow_id     TEXT,                     -- Workflow SDK runId
  hook_token      TEXT,                     -- token for waking this agent
  status          TEXT NOT NULL DEFAULT 'created',  -- created|running|sleeping|stopped|failed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(scope_type, scope_id, agent_role)
)

-- DB-mounted files for agents (with full version history)
-- The reflection agent's updates to strategy.md create new versions here
account_files (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,            -- "/persona.md", "/soul.md", "/agents.md"
  version         INT NOT NULL,
  content         TEXT NOT NULL,
  author          TEXT NOT NULL,            -- "user" | "system" | "reflection_agent" | ...
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, path, version)
)
-- Convention: latest version is the live one. All history preserved.

-- Brand strategies (just metadata, content is in blob)
brand_strategies (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,
  blob_prefix     TEXT NOT NULL,            -- "brand_strategies/{id}/"
  created_at, updated_at
)

-- Campaigns (just metadata, content is in blob)
campaigns (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  strategy_id     TEXT REFERENCES brand_strategies(id),
  name            TEXT NOT NULL,
  blob_prefix     TEXT NOT NULL,            -- "campaigns/{id}/"
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft|ready|active|completed
  starts_at, ends_at,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
)

-- Many-to-many: which strategies/campaigns apply to which accounts
account_strategies (
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  strategy_id     TEXT NOT NULL REFERENCES brand_strategies(id),
  PRIMARY KEY (account_id, strategy_id)
)

account_campaigns (
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
  status          TEXT NOT NULL DEFAULT 'assigned',  -- assigned|in_production|active|completed
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, campaign_id)
)

-- Watched accounts: which accounts this account engages with
watched_accounts (
  account_id        TEXT NOT NULL REFERENCES accounts(id),
  target_account_id TEXT NOT NULL REFERENCES accounts(id),
  engagement_type   TEXT NOT NULL,          -- "like" | "comment" | "follow" | "repost"
  PRIMARY KEY (account_id, target_account_id, engagement_type)
)

-- Posts: what was published
posts (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  campaign_id     TEXT REFERENCES campaigns(id),
  post_type       TEXT NOT NULL,            -- "image" | "video" | "carousel" | "text"
  caption         TEXT,
  blob_path       TEXT,                     -- final rendered content
  platform_post_id TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft|ready|posted|failed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at       TIMESTAMPTZ,
  metadata        JSONB DEFAULT '{}'
)

-- Engagements: tracked interactions
engagements (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  post_id         TEXT REFERENCES posts(id),  -- NULL if engagement is not on a specific post
  engagement_type TEXT NOT NULL,            -- "like" | "comment" | "follow" | "share" | "view"
  target_account  TEXT,                     -- handle/id of target
  details         JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
)

-- Competitor observations: spread surveillance across operator runs
competitor_observations (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  competitor_handle TEXT NOT NULL,
  observation     TEXT NOT NULL,
  post_url        TEXT,
  saved_blob_path TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
)

-- Conversations: one per (scope, agent_role)
conversations (
  id              TEXT PRIMARY KEY,
  scope_type      TEXT NOT NULL,
  scope_id        TEXT NOT NULL,
  agent_role      TEXT NOT NULL,
  blob_prefix     TEXT NOT NULL,
  current_summary_path TEXT,
  current_cutoff_seq INT,
  created_at, updated_at,
  UNIQUE(scope_type, scope_id, agent_role)
)

-- Escalations: lead agents pause and ask user via UI
escalations (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  raised_by_role  TEXT NOT NULL,            -- which agent role raised it
  issue           TEXT NOT NULL,
  options         JSONB,                    -- suggested resolutions
  hook_token      TEXT NOT NULL,            -- agent is waiting on this hook
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending|resolved|dismissed
  resolution      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
)

-- Trial runs: campaigns evaluated on a subset of accounts before full rollout
campaign_trials (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
  trial_account_ids TEXT[] NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',  -- running|completed|cancelled
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  results         JSONB                     -- aggregated engagement metrics
)
```

## 7. Workflow composition pattern (LOAD-BEARING)

This is the most important architectural detail. The naive pattern doesn't work for long-running children, and the working pattern needs careful idempotency handling.

### What does NOT work

```typescript
// BROKEN — ties up serverless invocation, hits 300s timeout
invoke_sub_agent: tool({
  execute: async ({ role, args }) => {
    "use step"
    const run = await start(childWorkflow, [args])
    return await run.returnValue  // ← BLOCKS the step's HTTP invocation
  },
})
```

`"use step"` compiles to an isolated serverless function with a hard 300s wall clock. Awaiting `run.returnValue` inside it ties up that function and times out for any child running longer than 5 minutes.

### Key insight: `start()` returns immediately

`start()` is fire-and-forget. It returns a `Run` object as soon as the child workflow is registered in the event store — it does NOT wait for the child to finish. This means a step that only calls `start()` finishes within milliseconds, well within the 300s timeout. The long wait happens *outside* the step, on a hook awaited at the workflow level.

```
Tool execute (workflow context, no "use step")
  ├─ Step opens [<100ms]
  │    start() returns Run object immediately, child runs in background
  ├─ Step closes ✓
  ├─ await hook  ←  workflow suspends here, durably, for hours/days
  └─ Tool execute returns when child calls resumeHook
```

### The working pattern: fire-and-forget + hook callback + idempotency

```typescript
// Module level — define the hook factory
const subAgentCompletion = defineHook<SubAgentResult>()

// Inside the lead agent's tools
invoke_sub_agent: tool({
  description: 'Invoke a sub-agent. Blocks until it completes.',
  inputSchema: z.object({
    role: z.enum(['operator', 'content_producer', 'reflector']),
    args: z.any(),
  }),
  execute: async ({ role, args }, { messages }) => {
    // No "use step" on this execute — we want workflow-level suspension
    
    // Deterministic token derived from stable inputs (account + role + invocation
    // discriminator). MUST NOT use Date.now() or random — must replay identically.
    const invocationId = stableInvocationId(messages)  // e.g., hash of message count + role
    const token = `sub-done:${accountId}:${role}:${invocationId}`
    
    const hook = subAgentCompletion.create({ token })

    // Spawn child via start() — must be inside "use step"
    // Idempotency: check the DB before spawning to handle step retries
    const spawn = async () => {
      "use step"
      const existing = await db.agentInstances.findByHookToken(token)
      if (existing) {
        return existing.workflow_id  // already started in a prior attempt
      }
      const run = await start(subAgentWorkflow, [accountId, role, args, token])
      await db.agentInstances.upsert({
        scope_type: 'account',
        scope_id: accountId,
        agent_role: role,
        workflow_id: run.runId,
        hook_token: token,
        status: 'running',
      })
      return run.runId
    }
    await spawn()

    // Suspend parent durably via hook (not in a step — pure workflow await)
    const result = await hook
    return result
  },
})

// Child workflow signals back when done
// Defense in depth: child also checks idempotency on startup
async function subAgentWorkflow(
  accountId: string,
  role: string,
  args: any,
  completionToken: string,
) {
  "use workflow"

  // Idempotency check — if a different runId was registered for this token,
  // we are a duplicate (the spawn step retried and got the cached row).
  const checkOwnership = async () => {
    "use step"
    const row = await db.agentInstances.findByHookToken(completionToken)
    return row?.workflow_id === currentRunId()  // SDK provides current runId
  }
  if (!(await checkOwnership())) {
    return  // duplicate child — silently exit, the real one is running
  }
  
  const result = await runSubAgent(accountId, role, args)
  
  // Resume the parent
  const callback = async () => {
    "use step"
    await resumeHook(completionToken, { success: true, summary: result })
    await db.agentInstances.update(currentRunId(), { status: 'completed' })
  }
  await callback()
}
```

### Why idempotency matters here

Steps must be idempotent because they can be retried. The Workflow SDK caches successful step results in the event log, so on workflow replay a successfully-completed step is NOT re-executed. But if a step crashes mid-execution (e.g., network failure between `start()` registering the child and the result being persisted to the cache), the retry will run again.

`start()` does not have a built-in idempotency key (confirmed in research), so duplicate calls would create duplicate children. The fix is application-level:

1. **Deterministic completion token**: derived from stable inputs only. Never `Date.now()` or random — those would produce different tokens on replay, defeating the cache and creating duplicates.
2. **DB row keyed by token**: persisted before `start()` returns success. On retry, the step reads the DB first and returns the existing runId instead of starting again.
3. **Child self-check**: on startup, the child queries the DB by its completion token and exits silently if a different runId is already registered. Belt and suspenders.

### Constraints summary

| Where | `sleep()` / `hook` await works | `start()` works | `resumeHook()` works |
|-------|-------------------------------|-----------------|---------------------|
| Workflow body (`"use workflow"`) | ✅ | ❌ (must be in a step) | ❌ (forbidden) |
| `"use step"` function | ❌ | ✅ | ✅ |
| Tool `execute` (no `"use step"`) | ✅ | ❌ | ❌ |
| Tool `execute` (with `"use step"`) | ❌ | ✅ | ✅ |
| External (route handler) | n/a | ✅ | ✅ |

Pattern rules:
- For tools that need durability/retry on the action itself: use `"use step"`
- For tools that need to suspend the workflow (sleep, wait for hook): no `"use step"`
- For spawning children: wrap `start()` in a small helper with `"use step"`, call from the tool body
- All step bodies must be idempotent — use deterministic tokens, persist before returning success

## 8. Inter-agent communication

### Lead → sub-agents

Use the fire-and-forget + hook callback pattern (section 7). Lead's tools are sequential — it spawns one sub-agent, awaits the hook, processes the result, decides what's next.

### Sub-agents do NOT talk to each other directly

Sub-agents communicate via shared state:
- Files in `/workspace/`: reflection writes notes that producer reads
- Tables: posts, engagements, competitor_observations
- Lead's invocations: lead reads outputs from one sub-agent, decides whether to invoke another

This keeps the system simple and avoids deadlocks/coordination bugs.

### Cross-scope agents

Brand-level reflector reads engagement data from all accounts using its strategy. No special communication needed — just SQL queries with JOINs.

### Notifications from the platform

Phone receives DM/comment/follow → otacon-server detects via accessibility events → calls relay → relay forwards to orchestrator webhook:

```
POST /api/notify
{
  "account_id": "xhs:littlered123",
  "event_type": "dm" | "comment" | "follow",
  "payload": { ... }
}
```

Orchestrator looks up the account's lead agent's notification hook token and calls `resumeHook(token, payload)`. Lead wakes up, reads the notification, decides what to do (often: invoke operator to respond).

## 9. Lead agent compaction

Lead's conversation grows unbounded. We compact at high threshold (~200K tokens):

```typescript
const agent = new WorkflowAgent({
  // ...
  prepareStep: async ({ messages }) => {
    const tokens = estimateTokens(messages)
    
    if (tokens > 200_000) {
      // Pi-style: walk backward keeping recent ~40K tokens, summarize the rest
      const cutoff = findCutoffForKeepRecent(messages, 40_000)
      const oldMessages = messages.slice(0, cutoff)
      
      // Use existing summary if any (iterative compaction)
      const prevSummary = await loadCompactionSummary(conversationId)
      const newSummary = await summarize(oldMessages, prevSummary)
      
      // Persist seed and summary to blob
      await saveCompactionSeed(conversationId, oldMessages)
      await saveCompactionSummary(conversationId, newSummary)
      
      return {
        system: `${baseSystemPrompt}\n\n[Prior context summary]\n${newSummary}`,
        messages: messages.slice(cutoff),
      }
    }
    
    return {}
  },
})
```

Sub-agents start fresh each time — no compaction needed.

## 10. Lifecycle: account creation through operation

```
1. User creates account in UI
   → POST /api/accounts { user_id, account_type, role, ... }
   → INSERT into accounts, account_credentials
   → Create account_files entries: agents.md (hardcoded), persona.md, soul.md (user-provided)
   → Create blob namespace accounts/{id}/workspace/

2. User links brand strategy and assigns campaigns
   → POST /api/accounts/{id}/strategies, /api/accounts/{id}/campaigns

3. User starts the lead agent
   → POST /api/accounts/{id}/start
   → start(leadAgentWorkflow, [accountId])
   → INSERT agent_instances row with workflow_id, hook_token

4. Lead agent runs forever:
   - Reads root files into system prompt
   - Sleeps until something happens
   - On wake (notification, scheduled, or user message):
     - Decides what's needed
     - Invokes operator/producer/reflector via fire-and-forget + hook
     - Processes results
     - Sleeps again

5. User can interact with lead agent:
   POST /api/accounts/{id}/message { text: "post the spring lookbook today" }
   → resumeHook(lead's user-message hook token, { text })
   → lead wakes, reads message, acts

6. Notifications wake lead:
   POST /api/notify { account_id, event_type, payload }
   → resumeHook(lead's notification hook token, payload)

7. Escalations pause lead:
   When lead is stuck or needs approval, it calls escalate_to_user tool
   → INSERT into escalations
   → workflow suspends on hook
   UI shows pending escalations
   User responds → resumeHook → lead unblocks
```

## 11. Content flow: campaign creation to posting

```
1. User creates campaign
   → POST /api/campaigns { user_id, strategy_id, name }
   → INSERT into campaigns
   → Create blob namespace campaigns/{id}/

2. User invokes Campaign Content Director (with help)
   → POST /api/campaigns/{id}/produce
   → start(contentDirectorWorkflow, [campaignId])
   Director collaborates with user (via escalations) to:
   - Define brief.md
   - Upload materials (videos, images, music, copy)
   - Define composition_rules.md (e.g. "use 3 of 7 clips, 1 of 4 music tracks")
   - Define examples/

3. User assigns campaign to accounts
   → POST /api/accounts/{id}/campaigns { campaign_id }
   → INSERT account_campaigns
   → Triggers each account's lead via hook

4. Each account's lead invokes its Per-Account Content Producer
   → invoke_sub_agent({ role: "content_producer", args: { campaign_id } })
   Producer:
   - Reads /campaigns/{id}/brief.md, materials/, composition_rules.md
   - Reads account's /persona.md, /soul.md, /workspace/reflection/
   - Mixes materials per rules with account-specific variation
   - Writes /workspace/posts/{date}-{slug}/content.md + assets/
   - Inserts row into posts (status=ready)
   - Returns to lead with summary

5. Lead decides when to post
   - Queries engagements table for optimal timing
   - Invokes operator with task: "post /workspace/posts/{slug}/"

6. Operator posts
   - Reads the post content
   - Uses otacon to navigate, upload, caption, publish
   - Updates posts row (status=posted, platform_post_id)
   - Logs engagement metrics over time as it browses
```

## 12. Reflection flow

```
Account-Level Reflection:
1. Triggered by lead based on its own schedule (e.g. weekly) or events
   → invoke_sub_agent({ role: "reflector" })
2. Reflector reads:
   - posts table (recent posts for this account)
   - engagements table (metrics)
   - /workspace/posts/ (final content)
3. Analyzes patterns
4. Updates DB-mounted file: /workspace/reflection/{date}.md
5. May propose updates to /persona.md or /soul.md via escalation

Brand-Level Reflection:
1. Triggered on schedule (e.g. weekly) per brand strategy
2. Brand Reflector reads:
   - All accounts using this strategy
   - Their /workspace/reflection/* files
   - posts + engagements joined to those accounts
3. Aggregates cross-account patterns
4. Writes to brand_strategies/{id}/insights/{date}.md
5. Often raises an escalation to the user with strategic recommendations
   → User can update brand strategy or campaigns based on insights
```

## 13. Competitive analysis flow

```
1. Operators record observations during normal browsing
   - Tool: record_competitor_observation({ competitor_handle, observation, ... })
   - INSERT into competitor_observations
   - Distributed surveillance: each operator only sees what's natural for that account

2. Brand-level Competitive Analyst runs periodically
   → triggered by user or scheduled per brand strategy
   - Reads competitor_observations from accounts using this brand
   - Aggregates: trending content, competitor moves, audience reactions
   - Writes to brand_strategies/{id}/competitive/{date}.md
   - Raises escalation to user when significant signals emerge
```

## 14. Trial runs (instead of per-post review)

Per-post review doesn't scale. Instead, when a user creates a campaign:

```
1. User selects N trial accounts (e.g. 5 of 100)
   → POST /api/campaigns/{id}/trial { trial_account_ids: [...] }
   → INSERT campaign_trials
   → Assigns campaign only to trial accounts

2. Trial accounts post via normal flow over a period (e.g. 1 week)

3. Trial completion job aggregates results:
   - engagement metrics across trial posts
   - Detected issues (low engagement, negative comments)
   → UPDATE campaign_trials.results

4. User reviews results
   → POST /api/campaigns/{id}/rollout to assign to all accounts
   → OR /api/campaigns/{id}/cancel
   → OR refine and re-trial
```

## 15. Orchestrator HTTP API

The orchestrator exposes a thin HTTP API for users (UI) and webhooks. It's stateless — it just translates HTTP calls into workflow operations.

### Account management

```
POST   /api/accounts                          Create account
GET    /api/accounts                          List user's accounts
GET    /api/accounts/{id}                     Account detail
DELETE /api/accounts/{id}                     Soft-delete account (stops workflow)
POST   /api/accounts/{id}/start               Start the lead agent workflow
POST   /api/accounts/{id}/stop                Stop all workflows for this account
POST   /api/accounts/{id}/message             Send message to lead agent
GET    /api/accounts/{id}/conversation        Get full lead transcript
GET    /api/accounts/{id}/files/*             Read account files (DB or blob mount)
PUT    /api/accounts/{id}/files/*             Update account files (with versioning)

POST   /api/accounts/{id}/credentials         Add credential
PUT    /api/accounts/{id}/credentials/{cid}   Update credential
DELETE /api/accounts/{id}/credentials/{cid}   Remove credential

POST   /api/accounts/{id}/strategies          Link brand strategy
POST   /api/accounts/{id}/campaigns           Assign campaign
POST   /api/accounts/{id}/watched             Add watched account
```

### Brand strategies

```
POST   /api/strategies                        Create brand strategy
GET    /api/strategies                        List
GET    /api/strategies/{id}                   Detail
PUT    /api/strategies/{id}/files/*           Upload/update strategy files (blob)
GET    /api/strategies/{id}/files/*           Read strategy files
```

### Campaigns

```
POST   /api/campaigns                         Create campaign
GET    /api/campaigns                         List
GET    /api/campaigns/{id}                    Detail
POST   /api/campaigns/{id}/produce            Invoke Content Director
PUT    /api/campaigns/{id}/files/*            Update campaign files
GET    /api/campaigns/{id}/files/*            Read
POST   /api/campaigns/{id}/trial              Start a trial run
POST   /api/campaigns/{id}/rollout            Roll out to all assigned accounts
POST   /api/campaigns/{id}/cancel             Cancel campaign
```

### Posts and engagements (read-only views for users)

```
GET    /api/posts                             List with filters (account, campaign, date range)
GET    /api/posts/{id}                        Detail
GET    /api/engagements                       List with filters
GET    /api/competitor-observations           List
```

### Escalations

```
GET    /api/escalations?status=pending        List pending escalations
POST   /api/escalations/{id}/resolve          Resolve with user response
```

### Webhooks (from relay/phone)

```
POST   /webhook/notify                        Notification from a phone
       Body: { account_id, event_type, payload }
       Auth: bearer token from relay
       Action: resumeHook(account.lead.notification_token, payload)
```

### Cron triggers (Vercel cron in production)

```
GET    /cron/scheduled-reflection             Trigger reflection for due accounts
GET    /cron/scheduled-brand-reflection       Brand-level reflection
GET    /cron/scheduled-competitive-analysis   Competitive analysis aggregation
GET    /cron/trial-evaluation                 Evaluate completed trials
```

## 16. just-bash custom commands (in-process tools)

The agents see one tool: `bash`. just-bash interprets the command, dispatching custom commands implemented in TypeScript.

### Custom commands

```typescript
// Phone control via otacon
defineCommand('otacon', async (args, ctx) => {
  // imports otacon client lib in-process — no shelling out
  const accountId = ctx.env.ACCOUNT_ID
  const account = await db.accounts.get(accountId)
  const phoneId = await resolvePhoneFromCredentials(account.id)  // registry lookup
  const client = new OtaconClient({
    baseUrl: `${ctx.env.RELAY_URL}/phones/${phoneId}`,
    apiKey: ctx.env.RELAY_TOKEN,
  })
  // parse args, dispatch to client methods
})

// DB queries
defineCommand('query_posts', async (args, ctx) => { ... })
defineCommand('query_engagements', async (args, ctx) => { ... })
defineCommand('query_observations', async (args, ctx) => { ... })

// Logging
defineCommand('log_post', async (args, ctx) => { ... })
defineCommand('log_engagement', async (args, ctx) => { ... })
defineCommand('record_observation', async (args, ctx) => { ... })

// Standard unix tools (provided by just-bash): cat, grep, ls, jq, find, etc.
```

### Tool interface for AI SDK

```typescript
// Single agent tool: bash. The agent learns about custom commands from /tools.md.
const tools = {
  bash: tool({
    description: 'Run shell commands. Custom: otacon, query_posts, query_engagements, ...',
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }) => {
      "use step"  // retryable
      return await justBashInstance.exec(command)
    },
  }),
  
  // Workflow primitives wrapped as tools (no "use step")
  sleep_until: tool({
    description: 'Sleep until a duration or datetime',
    inputSchema: z.object({ until: z.string() }),
    execute: async ({ until }) => {
      await sleep(until)
      return `Resumed`
    },
  }),
  
  // Sub-agent invocation (lead only)
  invoke_sub_agent: tool({ ... }),  // pattern from section 7
  
  // Escalation (lead only)
  escalate_to_user: tool({
    description: 'Pause and ask user for input. Use when stuck or need approval.',
    inputSchema: z.object({
      issue: z.string(),
      options: z.array(z.string()).optional(),
    }),
    execute: async ({ issue, options }) => {
      const token = `escalation:${accountId}:${Date.now()}`
      const hook = escalationHook.create({ token })
      
      const persistEscalation = async () => {
        "use step"
        await db.escalations.insert({ account_id: accountId, issue, options, hook_token: token })
      }
      await persistEscalation()
      
      const response = await hook  // suspend until user resolves
      return response.resolution
    },
  }),
}
```

## 17. Local dev vs cloud deployment

### Local

```
- Postgres via Docker or Neon local proxy
- MinIO via Docker (S3-compatible)
- Workflow SDK with @workflow/world-local (file-backed)
- CLI runner: `npx tsx src/orchestrator/cli.ts start-account --id xhs:lily`
- Webhooks: ngrok or local-only, no relay
- otacon: direct Tailscale connection (developer is on the tailnet)
```

### Cloud (Vercel)

```
- Neon Postgres
- Vercel Blob (or Cloudflare R2)
- Workflow SDK with @workflow/world-vercel
- Vercel cron in vercel.json triggers /cron/* endpoints
- Webhooks: relay → orchestrator HTTPS endpoint with bearer auth
- otacon: orchestrator → relay (public) → Tailscale → Pi
```

The same code runs in both environments. Swap the world adapter, swap blob/DB clients, change env vars — that's it.

## 18. Relay server

A small VPS (e.g. $5/mo) joined to the Tailscale network and exposed publicly via Caddy:

```
Caddyfile:
    relay.yourdomain.com {
      tls letsencrypt
      
      @authenticated {
        header Authorization "Bearer {env.RELAY_TOKEN}"
      }
      handle @authenticated {
        @phone path_regexp /phones/(?<phone>[^/]+)(.*)
        handle @phone {
          rewrite * /phones/{re.phone.1}{re.phone.2}
          reverse_proxy https://otacon-pi.tail0437b8.ts.net:8443
        }
      }
      respond "Unauthorized" 401
    }
```

The orchestrator calls `https://relay.yourdomain.com/phones/phone-2/api/screenshot` with `Authorization: Bearer ...`. Relay validates, forwards to the Pi over Tailscale.

## 19. Open questions / future work

1. **Multi-tenancy for the orchestrator**: this design assumes the orchestrator is single-tenant per deployment. Multi-tenant deploys would need RLS on Postgres and per-user blob namespaces.

2. **Compaction tuning**: 200K threshold for lead is a guess. Probably needs tuning based on observed conversation growth rates. May want to make it adaptive (compact more aggressively when bills get high).

3. **Failure recovery**: if a sub-agent's workflow fails, the lead's hook never fires and it stays suspended forever. Need a watchdog: periodic job that checks for stale sub-agent runs (status=failed) and notifies the parent via the completion hook with `success: false`.

4. **Ban detection and recovery**: if an account gets banned, the operator's posts will start failing. Lead needs to detect this pattern and escalate. Possibly a separate health-check sub-agent.

5. **Cost controls**: each agent run consumes tokens. Need to track per-account, per-campaign, per-user spend and enforce limits. Probably integrated with the AI SDK's usage events.

6. **Rate limiting platform interactions**: posting too frequently triggers anti-spam. Lead and operator need to respect platform-specific limits (XHS allows N posts/day, etc). This should be in the playbook.

7. **A/B testing within campaigns**: variants of a campaign brief, rollout to subsets, compare engagement.

8. **Web UI**: this spec covers the API. The UI is its own design effort — but the API is shaped to support it (escalations, message, file editing, transcript view).

9. **Authorization model**: users own their own data. Need to enforce: content can only be distributed to accounts of the same user, brand strategies belong to a user, etc. Implement at the API layer with consistent auth middleware.

10. **Telemetry**: structured logging of agent decisions, tool calls, escalations. Useful for debugging and for future analysis ("why did this account underperform?").

## 20. Repo structure (proposed)

```
src/orchestrator/
  package.json
  src/
    index.ts                       Entry point (CLI or HTTP)
    api/                           HTTP route handlers
      accounts.ts
      strategies.ts
      campaigns.ts
      escalations.ts
      webhooks.ts
      cron.ts
    workflows/                     Workflow SDK functions
      lead-agent.ts                "use workflow" lead agent
      sub-agents/
        operator.ts
        content-producer.ts
        reflector.ts
      campaign/
        content-director.ts
      brand/
        brand-reflector.ts
        competitive-analyst.ts
    agents/                        Agent runtime construction
      build-agent.ts               WorkflowAgent factory
      tools/                       AI SDK tool definitions
        bash.ts
        sleep-until.ts
        invoke-sub-agent.ts
        escalate.ts
      prompts/                     System prompt assembly
        lead.ts
        operator.ts
        producer.ts
        reflector.ts
    sandbox/                       just-bash setup
      build-sandbox.ts             MountableFs construction
      commands/                    defineCommand implementations
        otacon.ts
        query-posts.ts
        query-engagements.ts
        log-post.ts
        log-engagement.ts
        record-observation.ts
      fs/
        db-backed-fs.ts
        blob-backed-fs.ts
    storage/
      db.ts                        Postgres client (Drizzle or kysely)
      blob.ts                      Blob storage abstraction
      schema.ts                    DB schema definitions
      migrations/
    domain/                        Pure-logic helpers
      compaction.ts                Pi-style compaction
      conversation.ts              Load/save messages
      account-files.ts             Versioned file ops on account_files table
      resolver.ts                  Account → phone resolution via registry
    config/
      env.ts                       Env var parsing
      models.ts                    Model config (Vercel AI Gateway IDs)
  test/
  cli/                             Local dev CLI
    start-account.ts
    create-campaign.ts
    ...
  vercel.json                      Cron config
```

## 21. Implementation milestones (suggested)

1. **Foundations**: DB schema + migrations, blob client, just-bash sandbox with `otacon` command. Verify a tool invocation goes phone → relay → Pi → ADB end-to-end.

2. **Single-account happy path**: Lead agent workflow that just sleeps and wakes on a hook. No sub-agents yet. Verify the durable suspension model works locally with `world-local`.

3. **First sub-agent**: Add operator. Lead invokes operator via the section-7 pattern. Operator does a simple task (take screenshot, log to DB). Verify the fire-and-forget + hook callback works for a 30-minute child.

4. **Sub-agent suite**: Add content producer and per-account reflector. Stateless, FS-driven.

5. **Campaign system**: campaigns table, blob namespace, content director workflow. Campaign assignment triggers per-account producer.

6. **Brand-level agents**: brand reflector and competitive analyst. Cross-account queries.

7. **Escalation UI**: API endpoints + a simple admin page that lists escalations and resolves them.

8. **Trial runs**: trial flow + aggregation cron job.

9. **Production deployment**: Vercel project, Neon, Vercel Blob, relay VPS, real otacon.

10. **Monitoring/cost controls**: usage tracking, cost dashboards, rate limiting.
