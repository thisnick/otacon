/**
 * Startup scan: any session whose `session.json` says `status: 'running'`
 * is left over from a previous server process. Mark it `aborted`, write
 * an `endedAt`, and append a synthetic `agent_end`-shaped Pi event to
 * `events.jsonl` so SSE consumers see a clean termination on replay.
 *
 * Per spec: server-restart-mid-stream durability is out of scope; this
 * is the cleanup we DO perform so the UI doesn't render a forever-spinning
 * "running" badge.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { sessionEventsFile } from '../storage/paths.js'
import { listSessions, readSessionMeta, writeSessionMeta, appendEventLine } from '../storage/session.js'
import type { OtaconEvent } from '../types.js'

export async function abortStaleRunningSessions(dataRoot: string): Promise<number> {
  let aborted = 0
  const wsRoot = path.join(dataRoot, 'workspaces')
  let wsEntries: string[]
  try {
    wsEntries = await fs.readdir(wsRoot)
  } catch {
    return 0
  }
  for (const ws of wsEntries) {
    const teamsRoot = path.join(wsRoot, ws, 'teams')
    let teamEntries: string[]
    try {
      teamEntries = await fs.readdir(teamsRoot)
    } catch {
      continue
    }
    for (const team of teamEntries) {
      const sessionIds = await listSessions(dataRoot, ws, team)
      for (const sid of sessionIds) {
        const meta = await readSessionMeta(dataRoot, ws, team, sid)
        if (!meta || meta.status !== 'running') continue
        const endedAt = Date.now()
        await writeSessionMeta(dataRoot, ws, team, {
          ...meta,
          status: 'aborted',
          endedAt,
          error: meta.error ?? 'server restarted while session was running',
        })
        // Synthetic terminal event so live-mode SSE consumers see [DONE].
        const synthetic: OtaconEvent = {
          kind: 'pi',
          // The exact AgentEvent shape is stricter than this synthetic.
          // Cast through unknown because the consumer only inspects
          // `event.type` to detect terminality.
          event: { type: 'agent_end' } as never,
          ts: endedAt,
        }
        try {
          await ensureFile(sessionEventsFile(dataRoot, ws, team, sid))
          await appendEventLine(dataRoot, ws, team, sid, JSON.stringify(synthetic))
        } catch {
          // best effort
        }
        aborted++
      }
    }
  }
  return aborted
}

async function ensureFile(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  try {
    await fs.access(file)
  } catch {
    await fs.writeFile(file, '', 'utf8')
  }
}
