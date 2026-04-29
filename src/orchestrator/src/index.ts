#!/usr/bin/env node
import 'dotenv/config'
import { Command } from 'commander'
import { createDb } from './db/client.js'
import { runCommand } from './cli/run.js'
import { addAccountCommand } from './cli/add-account.js'
import { logsCommand } from './cli/logs.js'
import { statusCommand } from './cli/status.js'
import {
  inspectConversationsCommand,
  inspectConversationCommand,
  inspectStateCommand,
  inspectSchemaCommand,
  inspectCommandsCommand,
  inspectLogsCommand,
} from './cli/inspect.js'
import { seedTeamCommand } from './cli/seed-team.js'

const program = new Command()
  .name('orchestrator')
  .description('AI agent orchestrator for phone automation')
  .version('0.1.0')

function getDb() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set. Check src/orchestrator/.env')
  return createDb(url)
}

function deprecated(oldName: string, newName: string) {
  console.error(`[deprecated] '${oldName}' is deprecated; use '${newName}' instead.`)
}

// ── service group ──────────────────────────────────────────────────────────

const service = program.command('service').description('Setup, registration, and maintenance commands.')

service
  .command('add-account')
  .description('Register a new account')
  .requiredOption('--id <id>', 'Account ID (e.g. xhs:test)')
  .option('--phone-number <number>', 'Phone number credential (e.g. +15551234567)')
  .option('--email <email>', 'Email credential')
  .action(async (opts) => {
    const db = getDb()
    await addAccountCommand({
      id: opts.id,
      phoneNumber: opts.phoneNumber,
      email: opts.email,
      db,
    })
  })

service
  .command('migrate')
  .description('Apply DB migrations')
  .action(async () => {
    const { neon } = await import('@neondatabase/serverless')
    const { drizzle } = await import('drizzle-orm/neon-http')
    const { migrate } = await import('drizzle-orm/neon-http/migrator')
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL not set')
    const sql = neon(url)
    const db = drizzle(sql)
    console.log('Running migrations...')
    await migrate(db, { migrationsFolder: './src/db/migrations' })
    console.log('Migrations complete.')
  })

service
  .command('generate')
  .description('Run drizzle-kit generate')
  .action(async () => {
    const { spawn } = await import('node:child_process')
    const child = spawn('npx', ['drizzle-kit', 'generate'], { stdio: 'inherit' })
    await new Promise<void>((resolve, reject) => {
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`drizzle-kit exited ${code}`)))
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

// ── agent group ────────────────────────────────────────────────────────────

const agent = program.command('agent').description('Run / control agents.')

agent
  .command('run')
  .description('Start or resume a team for an account')
  .requiredOption('--account <id>', 'Account ID (e.g. xhs:test)')
  .option('--team <name>', 'Team name', 'social-media-engagement')
  .option('--prompt <text>', 'Initial prompt for the lead agent')
  .action(async (opts) => {
    const db = getDb()
    await runCommand({
      account: opts.account,
      team: opts.team,
      prompt: opts.prompt,
      db,
    })
  })

// ── inspect group ──────────────────────────────────────────────────────────

const inspect = program.command('inspect').description('Read-only views over conversations, allocations, and activity.')

inspect
  .command('conversations')
  .description('List conversations with summary stats')
  .option('--account <id>', 'Filter by account ID')
  .action(async (opts) => {
    const db = getDb()
    await inspectConversationsCommand({ db, account: opts.account })
  })

inspect
  .command('conversation')
  .description('Generate a markdown report combining messages + traces')
  .argument('<conversation_id>', 'Conversation ULID')
  .action(async (conversationId: string) => {
    const db = getDb()
    await inspectConversationCommand({ db, conversationId })
  })

inspect
  .command('state')
  .description('Print active allocations, running agents, recent activity')
  .option('--account <id>', 'Filter by account ID')
  .action(async (opts) => {
    const db = getDb()
    await inspectStateCommand({ db, account: opts.account })
  })

inspect
  .command('schema')
  .description('Print DB table list with column counts')
  .action(async () => {
    const db = getDb()
    await inspectSchemaCommand({ db })
  })

inspect
  .command('commands')
  .description('Print the otacon + otacon-alloc registry contents')
  .action(async () => {
    await inspectCommandsCommand()
  })

inspect
  .command('logs')
  .description('Tail activity_log for an account')
  .requiredOption('--account <id>', 'Account ID')
  .option('--since <duration>', 'Time window (e.g. 24h, 1d)')
  .action(async (opts) => {
    const db = getDb()
    await inspectLogsCommand({ db, account: opts.account, since: opts.since })
  })

// ── Deprecated top-level aliases (one phase) ───────────────────────────────

program
  .command('run', { hidden: true })
  .description('[deprecated] use `agent run`')
  .requiredOption('--account <id>', 'Account ID')
  .option('--team <name>', 'Team name', 'social-media-engagement')
  .option('--prompt <text>', 'Initial prompt')
  .action(async (opts) => {
    deprecated('run', 'agent run')
    const db = getDb()
    await runCommand({ account: opts.account, team: opts.team, prompt: opts.prompt, db })
  })

program
  .command('add-account', { hidden: true })
  .description('[deprecated] use `service add-account`')
  .requiredOption('--id <id>', 'Account ID')
  .option('--phone-number <number>')
  .option('--email <email>')
  .action(async (opts) => {
    deprecated('add-account', 'service add-account')
    const db = getDb()
    await addAccountCommand({ id: opts.id, phoneNumber: opts.phoneNumber, email: opts.email, db })
  })

program
  .command('status', { hidden: true })
  .description('[deprecated] use `inspect state`')
  .action(async () => {
    deprecated('status', 'inspect state')
    const db = getDb()
    await statusCommand({ db })
  })

program
  .command('logs', { hidden: true })
  .description('[deprecated] use `inspect logs`')
  .requiredOption('--account <id>')
  .option('--since <duration>')
  .action(async (opts) => {
    deprecated('logs', 'inspect logs')
    const db = getDb()
    await logsCommand({ account: opts.account, since: opts.since, db })
  })

program
  .command('db:migrate', { hidden: true })
  .description('[deprecated] use `service migrate`')
  .action(async () => {
    deprecated('db:migrate', 'service migrate')
    // Reuse the implementation
    const { neon } = await import('@neondatabase/serverless')
    const { drizzle } = await import('drizzle-orm/neon-http')
    const { migrate } = await import('drizzle-orm/neon-http/migrator')
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL not set')
    const sql = neon(url)
    const db = drizzle(sql)
    await migrate(db, { migrationsFolder: './src/db/migrations' })
    console.log('Migrations complete.')
  })

program
  .command('db:generate', { hidden: true })
  .description('[deprecated] use `service generate`')
  .action(async () => {
    deprecated('db:generate', 'service generate')
    const { spawn } = await import('node:child_process')
    const child = spawn('npx', ['drizzle-kit', 'generate'], { stdio: 'inherit' })
    await new Promise<void>((resolve, reject) => {
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`drizzle-kit exited ${code}`)))
    })
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
