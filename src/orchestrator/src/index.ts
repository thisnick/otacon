#!/usr/bin/env node
import 'dotenv/config'
import { Command } from 'commander'
import { createDb } from './db/client.js'
import { runCommand } from './cli/run.js'
import { addAccountCommand } from './cli/add-account.js'
import { logsCommand } from './cli/logs.js'
import { statusCommand } from './cli/status.js'

const program = new Command()
  .name('orchestrator')
  .description('AI agent orchestrator for phone automation')
  .version('0.1.0')

function getDb() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set. Check src/orchestrator/.env')
  return createDb(url)
}

program
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

program
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

program
  .command('logs')
  .description('Query activity logs for an account')
  .requiredOption('--account <id>', 'Account ID')
  .option('--since <duration>', 'Time window (e.g. 24h, 1d)')
  .action(async (opts) => {
    const db = getDb()
    await logsCommand({
      account: opts.account,
      since: opts.since,
      db,
    })
  })

program
  .command('status')
  .description('List running agent instances and accounts')
  .action(async () => {
    const db = getDb()
    await statusCommand({ db })
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
  // The workflow SDK handles persistence on its own;
  // we just need to let the current step finish
  setTimeout(() => {
    console.log('Shutdown complete.')
    process.exit(0)
  }, 5000)
})

program.parseAsync(process.argv).catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
