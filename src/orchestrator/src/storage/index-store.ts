/**
 * Append-only JSONL index files for fast list scans.
 *
 * Three indexes are maintained:
 *   - `index/runs.jsonl`           — all runs across all accounts
 *   - `index/by-account/{id}.jsonl` — per-account sublist
 *   - `index/by-status/{s}.jsonl`   — per-status sublist
 *
 * Each line is a `RunIndexEntry`. Status changes APPEND a new line — last
 * entry per `id` wins on read. Files are bounded to a few MB; if they grow
 * we can rotate later.
 *
 * `scripts/rebuild-index.ts` walks `runs/{id}/run.json` and rewrites all three
 * indexes from scratch (recovers from drift, e.g. after a crash mid-write).
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { PathLayout } from './paths.js'
import { indexByAccountFile, indexByStatusFile } from './paths.js'
import type { ListRunsOpts, RunIndexEntry, RunStatus } from './types.js'

export interface IndexStore {
  append(entry: RunIndexEntry): Promise<void>
  list(opts?: ListRunsOpts): Promise<RunIndexEntry[]>
  rebuild(entries: RunIndexEntry[]): Promise<void>
}

export class IndexStoreFs implements IndexStore {
  constructor(private layout: PathLayout) {}

  async append(entry: RunIndexEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n'

    const targets = [
      this.layout.indexRunsFile,
      indexByAccountFile(this.layout, entry.account),
      indexByStatusFile(this.layout, entry.status),
    ]

    for (const file of targets) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.appendFile(file, line, 'utf-8')
    }
  }

  async list(opts: ListRunsOpts = {}): Promise<RunIndexEntry[]> {
    const { account, team, status, limit, beforeId } = opts

    let entries: RunIndexEntry[]
    if (account) {
      entries = await readJsonl(indexByAccountFile(this.layout, account))
    } else if (status) {
      entries = await readJsonl(indexByStatusFile(this.layout, status))
    } else {
      entries = await readJsonl(this.layout.indexRunsFile)
    }

    // Last-write-wins dedupe by id — preserves the most recent status entry
    // for each run.
    const dedup = new Map<string, RunIndexEntry>()
    for (const e of entries) dedup.set(e.id, e)
    let results = [...dedup.values()]

    // Apply remaining filters that aren't satisfied by the source file alone.
    if (team) results = results.filter(r => r.team === team)
    if (status && account) results = results.filter(r => r.status === status)
    if (account && status) {
      // Already filtered by-account file; status filter applied above.
    }

    // Sort newest-first by startedAt (then id for stable order).
    results.sort((a, b) => {
      if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt
      return b.id.localeCompare(a.id)
    })

    if (beforeId) {
      const idx = results.findIndex(r => r.id === beforeId)
      if (idx >= 0) results = results.slice(idx + 1)
    }

    if (typeof limit === 'number' && limit >= 0) results = results.slice(0, limit)

    return results
  }

  /**
   * Rewrite all three index files from scratch. Used by
   * `scripts/rebuild-index.ts` and any caller that has authoritatively
   * enumerated each per-run `run.json` file.
   */
  async rebuild(entries: RunIndexEntry[]): Promise<void> {
    await fs.mkdir(this.layout.indexDir, { recursive: true })
    await fs.mkdir(this.layout.indexByAccountDir, { recursive: true })
    await fs.mkdir(this.layout.indexByStatusDir, { recursive: true })

    // Wipe the global index and per-account/per-status shards. We rewrite
    // exactly what's in `entries`, so anything else is stale.
    await rmIfExists(this.layout.indexRunsFile)
    await rmDirContents(this.layout.indexByAccountDir)
    await rmDirContents(this.layout.indexByStatusDir)

    const grouped: Record<string, RunIndexEntry[]> = {}
    const byStatus: Record<RunStatus, RunIndexEntry[]> = {
      created: [], running: [], completed: [], failed: [], cancelled: [],
    }
    for (const e of entries) {
      ;(grouped[e.account] ??= []).push(e)
      byStatus[e.status].push(e)
    }

    const writes: Promise<void>[] = []
    writes.push(writeJsonl(this.layout.indexRunsFile, entries))
    for (const [account, list] of Object.entries(grouped)) {
      writes.push(writeJsonl(indexByAccountFile(this.layout, account), list))
    }
    for (const [status, list] of Object.entries(byStatus) as [RunStatus, RunIndexEntry[]][]) {
      if (list.length > 0) writes.push(writeJsonl(indexByStatusFile(this.layout, status), list))
    }
    await Promise.all(writes)
  }
}

async function readJsonl(file: string): Promise<RunIndexEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch (e: any) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const out: RunIndexEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // Tolerate corrupt trailing lines from an interrupted write.
    }
  }
  return out
}

async function writeJsonl(file: string, entries: RunIndexEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const body = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '')
  await fs.writeFile(file, body, 'utf-8')
}

async function rmIfExists(file: string): Promise<void> {
  await fs.rm(file, { force: true })
}

async function rmDirContents(dir: string): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (e: any) {
    if (e.code === 'ENOENT') return
    throw e
  }
  await Promise.all(
    entries
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => fs.rm(path.join(dir, e.name), { force: true })),
  )
}
