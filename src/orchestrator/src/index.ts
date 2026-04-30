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
