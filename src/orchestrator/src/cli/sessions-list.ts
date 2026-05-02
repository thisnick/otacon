/**
 * `otacon sessions list` subcommand. Lists session ids under a workspace+team
 * with their session.json status.
 */
import type { Command } from 'commander'
import { dataRoot } from '../storage/paths.js'
import { listSessions, readSessionMeta } from '../storage/session.js'

export function registerSessionsList(program: Command): void {
  const sessions = program.command('sessions').description('Session management.')
  sessions
    .command('list')
    .description('List sessions for a workspace + team.')
    .requiredOption('-w, --workspace <id>', 'Workspace id.')
    .requiredOption('-t, --team <name>', 'Team name.')
    .option('--json', 'Output as JSON.')
    .action(async (optsRaw: { workspace: string; team: string; json?: boolean }) => {
      const root = dataRoot()
      const ids = await listSessions(root, optsRaw.workspace, optsRaw.team)
      const rows = []
      for (const id of ids) {
        const meta = await readSessionMeta(root, optsRaw.workspace, optsRaw.team, id)
        rows.push({
          id,
          status: meta?.status ?? 'unknown',
          startedAt: meta?.startedAt ?? null,
          endedAt: meta?.endedAt ?? null,
          modelId: meta?.modelId ?? null,
        })
      }
      if (optsRaw.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
        return
      }
      if (rows.length === 0) {
        process.stdout.write(`(no sessions for ${optsRaw.workspace} / ${optsRaw.team})\n`)
        return
      }
      const widths = {
        id: Math.max(2, ...rows.map(r => r.id.length)),
        status: Math.max(6, ...rows.map(r => r.status.length)),
        model: Math.max(5, ...rows.map(r => (r.modelId ?? '-').length)),
      }
      process.stdout.write(`${'id'.padEnd(widths.id)}  ${'status'.padEnd(widths.status)}  ${'model'.padEnd(widths.model)}  startedAt\n`)
      for (const r of rows) {
        const startedAt = r.startedAt ? new Date(r.startedAt).toISOString() : '-'
        process.stdout.write(`${r.id.padEnd(widths.id)}  ${r.status.padEnd(widths.status)}  ${(r.modelId ?? '-').padEnd(widths.model)}  ${startedAt}\n`)
      }
    })
}
