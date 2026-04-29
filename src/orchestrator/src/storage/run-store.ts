/**
 * RunStore: persisted RUN METADATA only — no chunks, no transcript.
 *
 * The chunk stream (text-deltas, tool-calls, data-* events) is owned by
 * @workflow/world-local. RunStore tracks our metadata (`run.json`), the
 * snapshotted system prompt, and propagates status changes to the index.
 *
 * On disk:
 *   runs/{runId}/run.json
 *   runs/{runId}/prompt.md
 *   runs/{runId}/traces/{toolCallId}/...   (managed by BlobStore)
 *   runs/{runId}/signals/{signalId}.json   (managed by SignalStore)
 *
 * Status changes call back into the IndexStore so list scans stay cheap.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { PathLayout } from './paths.js'
import { promptFile, runDir, runFile } from './paths.js'
import type {
  IndexStore,
} from './index-store.js'
import type {
  ListRunsOpts,
  Run,
  RunIndexEntry,
  RunInput,
  RunStatus,
} from './types.js'

export interface RunStore {
  create(input: RunInput): Promise<Run>
  get(runId: string): Promise<Run | null>
  list(opts?: ListRunsOpts): Promise<Run[]>
  /** Update status + optional fields. Appends a new index entry. */
  updateStatus(runId: string, status: RunStatus, fields?: Partial<Run>): Promise<Run>
  /** Patch arbitrary fields without changing status. No index write. */
  patch(runId: string, fields: Partial<Run>): Promise<Run>
  putPromptSnapshot(runId: string, prompt: string): Promise<string>
  getPromptSnapshot(runId: string): Promise<string | null>
}

export class RunStoreFs implements RunStore {
  constructor(
    private layout: PathLayout,
    private index: IndexStore,
  ) {}

  async create(input: RunInput): Promise<Run> {
    const run: Run = {
      id: input.id,
      workflowRunId: input.workflowRunId ?? null,
      account: input.account,
      team: input.team,
      agentRole: input.agentRole,
      model: input.model,
      promptTemplatePaths: input.promptTemplatePaths ?? [],
      promptSnapshotPath: input.promptSnapshotPath ?? null,
      initialPrompt: input.initialPrompt ?? null,
      status: 'created',
      startedAt: Date.now(),
      completedAt: null,
      finalText: null,
      error: null,
      turnCount: 0,
    }
    await fs.mkdir(runDir(this.layout, run.id), { recursive: true })
    await writeRunFile(this.layout, run)
    await this.index.append(toIndexEntry(run))
    return run
  }

  async get(runId: string): Promise<Run | null> {
    try {
      const raw = await fs.readFile(runFile(this.layout, runId), 'utf-8')
      return JSON.parse(raw) as Run
    } catch (e: any) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }

  async list(opts?: ListRunsOpts): Promise<Run[]> {
    const entries = await this.index.list(opts)
    const runs: Run[] = []
    for (const e of entries) {
      const r = await this.get(e.id)
      if (r) runs.push(r)
    }
    return runs
  }

  async updateStatus(runId: string, status: RunStatus, fields: Partial<Run> = {}): Promise<Run> {
    const current = await this.get(runId)
    if (!current) throw new Error(`run "${runId}" not found`)
    const next: Run = {
      ...current,
      ...fields,
      id: current.id,
      startedAt: current.startedAt,
      status,
      completedAt:
        fields.completedAt !== undefined
          ? fields.completedAt
          : isTerminal(status)
            ? Date.now()
            : current.completedAt,
    }
    await writeRunFile(this.layout, next)
    await this.index.append(toIndexEntry(next))
    return next
  }

  async patch(runId: string, fields: Partial<Run>): Promise<Run> {
    const current = await this.get(runId)
    if (!current) throw new Error(`run "${runId}" not found`)
    const next: Run = {
      ...current,
      ...fields,
      id: current.id,
      startedAt: current.startedAt,
      status: current.status,
    }
    await writeRunFile(this.layout, next)
    return next
  }

  async putPromptSnapshot(runId: string, prompt: string): Promise<string> {
    await fs.mkdir(runDir(this.layout, runId), { recursive: true })
    const file = promptFile(this.layout, runId)
    await fs.writeFile(file, prompt, 'utf-8')
    // Stash the relative path in run.json so consumers know where to find it.
    const rel = path.relative(this.layout.root, file)
    const current = await this.get(runId)
    if (current && current.promptSnapshotPath !== rel) {
      await this.patch(runId, { promptSnapshotPath: rel })
    }
    return rel
  }

  async getPromptSnapshot(runId: string): Promise<string | null> {
    try {
      return await fs.readFile(promptFile(this.layout, runId), 'utf-8')
    } catch (e: any) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }
}

function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function toIndexEntry(run: Run): RunIndexEntry {
  return {
    id: run.id,
    account: run.account,
    team: run.team,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  }
}

async function writeRunFile(layout: PathLayout, run: Run): Promise<void> {
  await fs.writeFile(runFile(layout, run.id), JSON.stringify(run, null, 2), 'utf-8')
}
