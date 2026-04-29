/**
 * SignalStore: persisted approval/escalation/user-message signals + their
 * mapping to Workflow SDK hook tokens.
 *
 * The actual workflow suspension is handled by Workflow SDK's `createHook()`.
 * This store records:
 *   - the signal id (our identifier — what UI/CLI uses)
 *   - the hook token (Workflow SDK's identifier — what `resumeHook()` uses)
 *   - the user-visible payload (command, rationale, screenshot path)
 *   - the resolution (decision, message, resolved-at timestamp)
 *
 * On disk:
 *   runs/{runId}/signals/{signalId}.json
 *
 * Listing scans `runs/*\/signals/*.json` — fine for the run counts we expect.
 * If pending-signal scans get hot we can add an index later.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { PathLayout } from './paths.js'
import { runSignalDir, runSignalFile } from './paths.js'
import type {
  Signal,
  SignalInput,
  SignalStatus,
} from './types.js'
import { ulid } from './ulid.js'

export interface SignalStore {
  create(input: SignalInput): Promise<Signal>
  get(signalId: string): Promise<Signal | null>
  /** Lookup by hookToken — used by HTTP signal-resolve handlers. */
  getByHookToken(token: string): Promise<Signal | null>
  list(opts?: { runId?: string; status?: SignalStatus }): Promise<Signal[]>
  markResolved(
    signalId: string,
    decision: 'approve' | 'reject' | 'skip',
    message?: string,
  ): Promise<Signal>
}

export class SignalStoreFs implements SignalStore {
  constructor(private layout: PathLayout) {}

  async create(input: SignalInput): Promise<Signal> {
    const id = input.id ?? ulid()
    const signal: Signal = {
      id,
      runId: input.runId,
      kind: input.kind,
      status: 'pending',
      hookToken: input.hookToken,
      toolCallId: input.toolCallId ?? null,
      command: input.command ?? null,
      rationale: input.rationale ?? null,
      screenshotPath: input.screenshotPath ?? null,
      createdAt: Date.now(),
      resolvedAt: null,
      decision: null,
      message: null,
      payload: input.payload ?? {},
    }
    await fs.mkdir(runSignalDir(this.layout, signal.runId), { recursive: true })
    await fs.writeFile(
      runSignalFile(this.layout, signal.runId, signal.id),
      JSON.stringify(signal, null, 2),
      'utf-8',
    )
    return signal
  }

  async get(signalId: string): Promise<Signal | null> {
    const file = await this.findSignalFile(signalId)
    if (!file) return null
    return readSignalFile(file)
  }

  async getByHookToken(token: string): Promise<Signal | null> {
    const all = await this.list()
    return all.find(s => s.hookToken === token) ?? null
  }

  async list(opts: { runId?: string; status?: SignalStatus } = {}): Promise<Signal[]> {
    const runIds = opts.runId ? [opts.runId] : await listRunIds(this.layout)
    const out: Signal[] = []
    for (const runId of runIds) {
      const dir = runSignalDir(this.layout, runId)
      let entries: string[]
      try {
        entries = await fs.readdir(dir)
      } catch (e: any) {
        if (e.code === 'ENOENT') continue
        throw e
      }
      for (const name of entries) {
        if (!name.endsWith('.json')) continue
        const signal = await readSignalFile(path.join(dir, name))
        if (!signal) continue
        if (opts.status && signal.status !== opts.status) continue
        out.push(signal)
      }
    }
    out.sort((a, b) => a.createdAt - b.createdAt)
    return out
  }

  async markResolved(
    signalId: string,
    decision: 'approve' | 'reject' | 'skip',
    message?: string,
  ): Promise<Signal> {
    const file = await this.findSignalFile(signalId)
    if (!file) throw new Error(`signal "${signalId}" not found`)
    const current = await readSignalFile(file)
    if (!current) throw new Error(`signal "${signalId}" not found`)
    const status: SignalStatus =
      decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'skipped'
    const next: Signal = {
      ...current,
      status,
      decision,
      message: message ?? null,
      resolvedAt: Date.now(),
    }
    await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf-8')
    return next
  }

  /**
   * Resolve a signal id to its on-disk file by scanning the runs dir. Most
   * callers know the runId — this is for cases (e.g. `resumeHook` route) that
   * only have the signalId.
   */
  private async findSignalFile(signalId: string): Promise<string | null> {
    const runIds = await listRunIds(this.layout)
    for (const runId of runIds) {
      const file = runSignalFile(this.layout, runId, signalId)
      try {
        await fs.access(file)
        return file
      } catch {
        // try next run
      }
    }
    return null
  }
}

async function readSignalFile(file: string): Promise<Signal | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    return JSON.parse(raw) as Signal
  } catch (e: any) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

async function listRunIds(layout: PathLayout): Promise<string[]> {
  try {
    const entries = await fs.readdir(layout.runsDir, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch (e: any) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

