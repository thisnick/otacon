#!/usr/bin/env node
import 'dotenv/config'
import { Command } from 'commander'
import { addAccountCommand } from './cli/add-account.js'
import {
  inspectRunsCommand,
  inspectRunCommand,
  inspectRunPromptCommand,
} from './cli/inspect-runs.js'
import { inspectCommandsCommand } from './cli/inspect-commands.js'
import { runCommand } from './cli/run.js'
import { seedTeamCommand } from './cli/seed-team.js'
import { serveCommand } from './cli/serve.js'
import {
  runsListCommand,
  runsShowCommand,
  runsPromptCommand,
  runsMessagesCommand,
  runsCancelCommand,
  runsMessageCommand,
} from './cli/runs.js'
import { signalsListCommand, signalsResolveCommand } from './cli/signals.js'
import {
  accountsListCommand,
  accountsAddCommand,
  accountsShowCommand,
  accountsEnvGetCommand,
  accountsEnvPutCommand,
  accountsEnvDeleteCommand,
} from './cli/accounts.js'
import { teamsListCommand, teamsShowCommand } from './cli/teams.js'

const program = new Command()
  .name('orchestrator')
  .description('AI agent orchestrator for phone automation')
  .version('0.2.0')

// ── service group ──────────────────────────────────────────────────────────

const service = program.command('service').description('Setup, registration, and maintenance commands.')

service
  .command('add-account')
  .description('Register a new account in the FS-backed AccountStore')
  .requiredOption('--id <id>', 'Account ID (e.g. xhs:test)')
  .option('--phone-number <number>', 'Phone number credential (e.g. +15551234567)')
  .option('--email <email>', 'Email credential')
  .option('--data-dir <dir>', 'Override ORCHESTRATOR_DATA_DIR for this invocation')
  .action(async (opts) => {
    await addAccountCommand({
      id: opts.id,
      phoneNumber: opts.phoneNumber,
      email: opts.email,
      dataDir: opts.dataDir,
    })
  })

service
  .command('seed-team')
  .description('Copy an in-tree team into the runtime data dir (idempotent)')
  .requiredOption('--name <name>', 'Team name (e.g. social-media-engagement)')
  .option('--data-dir <dir>', 'Override ORCHESTRATOR_DATA_DIR for this invocation')
  .action(async (opts) => {
    await seedTeamCommand({ name: opts.name, dataDir: opts.dataDir })
  })

// ── serve ─────────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('Boot the Nitro server (dev mode by default; --prod runs the built bundle)')
  .option('--prod', 'Run node .output/server/index.mjs (requires `pnpm build:server` first)')
  .action(async (opts) => {
    await serveCommand({ prod: opts.prod })
  })

// ── agent group ────────────────────────────────────────────────────────────

const agent = program.command('agent').description('Run / control agents.')

agent
  .command('run')
  .description('Start a run via the orchestrator HTTP server (requires `pnpm orchestrator serve` running)')
  .requiredOption('--account <id>', 'Account ID (e.g. xhs:test)')
  .option('--team <name>', 'Team name', 'social-media-engagement')
  .option('--prompt <text>', 'Initial prompt for the lead agent')
  .option('--url <url>', 'Orchestrator HTTP URL (defaults to ORCHESTRATOR_URL env or http://localhost:9090)')
  .option('--auto-approve', 'Auto-approve every approval signal (no stdin prompt)')
  .action(async (opts) => {
    await runCommand({
      account: opts.account,
      team: opts.team,
      prompt: opts.prompt,
      url: opts.url,
      autoApprove: opts.autoApprove,
    })
  })

// ── inspect group ──────────────────────────────────────────────────────────

const inspect = program.command('inspect').description('Read-only views over runs and the bash command registry.')

inspect
  .command('runs')
  .description('List runs (reads RunStore)')
  .option('--account <id>', 'Filter by account ID')
  .option('--status <status>', 'Filter by status (created|running|completed|failed|cancelled)')
  .option('--limit <n>', 'Max rows to return', (v: string) => parseInt(v, 10), 50)
  .option('--json', 'Emit JSON instead of a table')
  .option('--data-dir <dir>', 'Override ORCHESTRATOR_DATA_DIR')
  .action(async (opts) => {
    await inspectRunsCommand({
      account: opts.account,
      status: opts.status,
      limit: opts.limit,
      json: opts.json,
      dataDir: opts.dataDir,
    })
  })

inspect
  .command('run')
  .description('Markdown report for a run (reads RunStore + Workflow SDK chunk replay)')
  .argument('<run_id>', 'Run ULID (our orchestrator runId, NOT the workflow runId)')
  .option('--json', 'Emit JSON ({run, messages, replayError}) instead of markdown')
  .option('--data-dir <dir>', 'Override ORCHESTRATOR_DATA_DIR')
  .action(async (runId: string, opts) => {
    await inspectRunCommand({ runId, json: opts.json, dataDir: opts.dataDir })
  })

inspect
  .command('run-prompt')
  .description('Print the snapshotted system prompt for a run')
  .argument('<run_id>', 'Run ULID')
  .option('--data-dir <dir>', 'Override ORCHESTRATOR_DATA_DIR')
  .action(async (runId: string, opts) => {
    await inspectRunPromptCommand({ runId, dataDir: opts.dataDir })
  })

inspect
  .command('commands')
  .description('Print the otacon + otacon-alloc registry contents')
  .action(async () => {
    await inspectCommandsCommand()
  })

// ── runs group (HTTP) ──────────────────────────────────────────────────────

const runs = program.command('runs').description('HTTP-backed run inspection + control (talks to a running orchestrator).')

runs
  .command('list')
  .description('List runs via GET /api/v1/runs')
  .option('--account <id>', 'Filter by account ID')
  .option('--status <status>', 'Filter by status')
  .option('--team <name>', 'Filter by team')
  .option('--limit <n>', 'Max rows', (v: string) => parseInt(v, 10), 50)
  .option('--json', 'Emit JSON')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (opts) => {
    await runsListCommand(opts)
  })

runs
  .command('show')
  .description('Show run metadata via GET /api/v1/runs/:id')
  .argument('<run_id>')
  .option('--json', 'Emit JSON')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (runId: string, opts) => {
    await runsShowCommand({ runId, ...opts })
  })

runs
  .command('prompt')
  .description('Print the snapshotted system prompt via GET /api/v1/runs/:id/prompt')
  .argument('<run_id>')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (runId: string, opts) => {
    await runsPromptCommand({ runId, ...opts })
  })

runs
  .command('messages')
  .description('Print the full conversation via GET /api/v1/runs/:id/messages')
  .argument('<run_id>')
  .option('--json', 'Emit JSON')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (runId: string, opts) => {
    await runsMessagesCommand({ runId, ...opts })
  })

runs
  .command('cancel')
  .description('Cancel a running workflow via POST /api/v1/runs/:id/cancel')
  .argument('<run_id>')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (runId: string, opts) => {
    await runsCancelCommand({ runId, ...opts })
  })

runs
  .command('message')
  .description('Enqueue a user message via POST /api/v1/runs/:id/messages')
  .argument('<run_id>')
  .argument('<text...>')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (runId: string, text: string[], opts) => {
    await runsMessageCommand({ runId, content: text.join(' '), ...opts })
  })

// ── signals group (HTTP) ───────────────────────────────────────────────────

const signals = program.command('signals').description('Approval / escalation signals.')

signals
  .command('list')
  .description('List signals via GET /api/v1/signals')
  .option('--status <s>', 'pending|approved|rejected|skipped')
  .option('--run-id <id>', 'Filter to one run')
  .option('--json', 'Emit JSON')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (opts) => {
    await signalsListCommand({
      status: opts.status,
      runId: opts.runId,
      json: opts.json,
      url: opts.url,
    })
  })

signals
  .command('resolve')
  .description('Resolve a pending signal via POST /api/v1/signals/:id/resolve')
  .argument('<signal_id>')
  .argument('<decision>', 'approve | reject | skip')
  .option('--message <text>', 'Optional human-readable note')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (signalId: string, decision: string, opts) => {
    if (decision !== 'approve' && decision !== 'reject' && decision !== 'skip') {
      throw new Error(`decision must be one of: approve, reject, skip (got "${decision}")`)
    }
    await signalsResolveCommand({
      signalId,
      decision,
      message: opts.message,
      url: opts.url,
    })
  })

// ── accounts group (HTTP) ──────────────────────────────────────────────────

const accounts = program.command('accounts').description('HTTP-backed accounts CRUD + env file management.')

accounts
  .command('list')
  .description('List accounts via GET /api/v1/accounts')
  .option('--json', 'Emit JSON')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (opts) => {
    await accountsListCommand(opts)
  })

accounts
  .command('add')
  .description('Create or fetch an account via POST /api/v1/accounts')
  .argument('<id>', 'Account ID (e.g. xhs:test)')
  .option('--display-name <name>', 'Optional human-readable name')
  .option('--phone-number <number>', 'Optional phone credential')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (id: string, opts) => {
    await accountsAddCommand({
      id,
      displayName: opts.displayName,
      phoneNumber: opts.phoneNumber,
      url: opts.url,
    })
  })

accounts
  .command('show')
  .description('Show account metadata via GET /api/v1/accounts/:id')
  .argument('<id>')
  .option('--json', 'Emit JSON')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (id: string, opts) => {
    await accountsShowCommand({ id, ...opts })
  })

const accountsEnv = accounts.command('env').description('Env file CRUD (persona.md / soul.md / agents.md).')

accountsEnv
  .command('get')
  .description('Read an env file via GET /api/v1/accounts/:id/env/:file')
  .argument('<id>')
  .argument('<file>', 'persona.md | soul.md | agents.md')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (id: string, file: string, opts) => {
    await accountsEnvGetCommand({ id, file, ...opts })
  })

accountsEnv
  .command('put')
  .description('Replace an env file via PUT /api/v1/accounts/:id/env/:file')
  .argument('<id>')
  .argument('<file>')
  .option('-c, --content <path>', 'Read content from file (default: stdin)')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (id: string, file: string, opts) => {
    await accountsEnvPutCommand({ id, file, content: opts.content, url: opts.url })
  })

accountsEnv
  .command('delete')
  .description('Delete an env file via DELETE /api/v1/accounts/:id/env/:file')
  .argument('<id>')
  .argument('<file>')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (id: string, file: string, opts) => {
    await accountsEnvDeleteCommand({ id, file, ...opts })
  })

// ── teams group (HTTP) ─────────────────────────────────────────────────────

const teams = program.command('teams').description('HTTP-backed team listing.')

teams
  .command('list')
  .description('List teams via GET /api/v1/teams')
  .option('--json', 'Emit JSON')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (opts) => {
    await teamsListCommand(opts)
  })

teams
  .command('show')
  .description('Show team config via GET /api/v1/teams/:name')
  .argument('<name>')
  .option('--json', 'Emit JSON')
  .option('--url <url>', 'Override ORCHESTRATOR_URL')
  .action(async (name: string, opts) => {
    await teamsShowCommand({ name, ...opts })
  })

// Graceful shutdown
let shuttingDown = false
process.on('SIGINT', () => {
  if (shuttingDown) {
    console.log('\nForce exit.')
    process.exit(1)
  }
  shuttingDown = true
  console.log('\nShutting down gracefully... (press Ctrl+C again to force)')
  setTimeout(() => {
    console.log('Shutdown complete.')
    process.exit(0)
  }, 5000)
})

program.parseAsync(process.argv).catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
