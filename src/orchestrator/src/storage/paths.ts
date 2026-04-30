/**
 * Filesystem layout constants for the orchestrator data directory.
 *
 * Layout (under ORCHESTRATOR_DATA_DIR):
 *
 *   accounts/{id}/account.json
 *   accounts/{id}/credentials.json
 *   accounts/{id}/env/{file}
 *   accounts/{id}/workspace/...
 *
 *   teams/{name}/team.json
 *   teams/{name}/prompts/{file}
 *
 *   runs/{runId}/run.json
 *   runs/{runId}/prompt.md
 *   runs/{runId}/traces/{toolCallId}/{before,annotated,after}.png
 *   runs/{runId}/traces/{toolCallId}/result.json
 *   runs/{runId}/signals/{signalId}.json
 *
 *   workflow/...                    (owned by @workflow/world-local)
 *
 *   index/runs.jsonl
 *   index/by-account/{accountId}.jsonl
 *   index/by-status/{status}.jsonl
 *
 *   allocations.json                (FS phone-allocation lock; replaces
 *                                    the phoneAllocations DB table)
 */
import * as path from 'node:path'

export const DEFAULT_DATA_DIR = '.orchestrator-data'

export interface PathLayout {
  root: string
  accountsDir: string
  teamsDir: string
  runsDir: string
  workflowDir: string
  indexDir: string
  indexRunsFile: string
  indexByAccountDir: string
  indexByStatusDir: string
  allocationsFile: string
}

export function makePaths(dataDir: string): PathLayout {
  const root = path.resolve(dataDir)
  return {
    root,
    accountsDir: path.join(root, 'accounts'),
    teamsDir: path.join(root, 'teams'),
    runsDir: path.join(root, 'runs'),
    workflowDir: path.join(root, 'workflow'),
    indexDir: path.join(root, 'index'),
    indexRunsFile: path.join(root, 'index', 'runs.jsonl'),
    indexByAccountDir: path.join(root, 'index', 'by-account'),
    indexByStatusDir: path.join(root, 'index', 'by-status'),
    allocationsFile: path.join(root, 'allocations.json'),
  }
}

export function accountDir(layout: PathLayout, accountId: string): string {
  assertSafeId(accountId)
  return path.join(layout.accountsDir, accountId)
}

export function accountFile(layout: PathLayout, accountId: string): string {
  return path.join(accountDir(layout, accountId), 'account.json')
}

export function credentialsFile(layout: PathLayout, accountId: string): string {
  return path.join(accountDir(layout, accountId), 'credentials.json')
}

export function accountEnvFile(layout: PathLayout, accountId: string, relPath: string): string {
  return resolveWithin(path.join(accountDir(layout, accountId), 'env'), relPath)
}

export function accountWorkspaceDir(layout: PathLayout, accountId: string): string {
  return path.join(accountDir(layout, accountId), 'workspace')
}

export function teamDir(layout: PathLayout, teamName: string): string {
  assertSafeId(teamName)
  return path.join(layout.teamsDir, teamName)
}

export function teamFile(layout: PathLayout, teamName: string): string {
  return path.join(teamDir(layout, teamName), 'team.json')
}

export function teamPromptFile(layout: PathLayout, teamName: string, relPath: string): string {
  return resolveWithin(path.join(teamDir(layout, teamName), 'prompts'), relPath)
}

export function runDir(layout: PathLayout, runId: string): string {
  assertSafeId(runId)
  return path.join(layout.runsDir, runId)
}

export function runFile(layout: PathLayout, runId: string): string {
  return path.join(runDir(layout, runId), 'run.json')
}

export function promptFile(layout: PathLayout, runId: string): string {
  return path.join(runDir(layout, runId), 'prompt.md')
}

export function runSignalDir(layout: PathLayout, runId: string): string {
  return path.join(runDir(layout, runId), 'signals')
}

export function runSignalFile(layout: PathLayout, runId: string, signalId: string): string {
  assertSafeId(signalId)
  return path.join(runSignalDir(layout, runId), `${signalId}.json`)
}

/**
 * Inbox JSONL for `POST /api/v1/runs/:id/messages` user-injected messages.
 * The workflow body drains it at each turn boundary inside a step and
 * prepends new messages to the next turn's prompt. Lives at
 * `runs/{runId}/messages-inbox.jsonl`. Append-only from the route side;
 * read-and-truncate from the workflow step.
 */
export function runMessagesInboxFile(layout: PathLayout, runId: string): string {
  return path.join(runDir(layout, runId), 'messages-inbox.jsonl')
}

export function runTraceDir(layout: PathLayout, runId: string, toolCallId: string): string {
  assertSafeId(toolCallId)
  return path.join(runDir(layout, runId), 'traces', toolCallId)
}

export function runTraceFile(
  layout: PathLayout,
  runId: string,
  toolCallId: string,
  filename: string,
): string {
  assertSafeId(filename)
  return path.join(runTraceDir(layout, runId, toolCallId), filename)
}

export function indexByAccountFile(layout: PathLayout, accountId: string): string {
  assertSafeId(accountId)
  return path.join(layout.indexByAccountDir, `${accountId}.jsonl`)
}

export function indexByStatusFile(layout: PathLayout, status: string): string {
  assertSafeId(status)
  return path.join(layout.indexByStatusDir, `${status}.jsonl`)
}

const ID_RE = /^[A-Za-z0-9._:+-]+$/

/**
 * Reject IDs with path separators or shell metacharacters. Most legitimate IDs
 * (account ids like `xhs:test`, run ULIDs, team slugs) are safe under this
 * pattern; anything else is a likely injection attempt.
 */
export function assertSafeId(id: string): void {
  if (!id || !ID_RE.test(id)) {
    throw new Error(`unsafe id: ${JSON.stringify(id)}`)
  }
}

/**
 * Resolve `relPath` under `baseDir` and reject any traversal that escapes the
 * base. Returns the absolute path on success.
 *
 * Rejects absolute paths outright — callers must provide a relative path. We
 * could silently strip the leading slash, but treating absolute input as a
 * safe relative path is the kind of papering-over that masks injection bugs.
 */
export function resolveWithin(baseDir: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error(`path traversal blocked: ${relPath}`)
  }
  const full = path.resolve(baseDir, relPath)
  const baseAbs = path.resolve(baseDir)
  if (full !== baseAbs && !full.startsWith(baseAbs + path.sep)) {
    throw new Error(`path traversal blocked: ${relPath}`)
  }
  return full
}
