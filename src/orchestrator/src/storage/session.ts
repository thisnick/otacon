/**
 * Session store — manages `sessions/<id>/` files + the `last-session.txt`
 * resume pointer.
 *
 *   session.json     — SessionMeta
 *   messages.jsonl   — Pi's Message[] verbatim, append on `pi.message_end`
 *   events.jsonl     — OtaconEvent[], append on every emit
 *   sandbox/         — symlink tree (env, memory, traces)
 *   traces/<tcid>/   — per-tool-call screenshots + result.json
 */
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import {
  sessionDir,
  sessionMetaFile,
  sessionMessagesFile,
  sessionEventsFile,
  sessionSandboxDir,
  sessionTracesDir,
  sessionEscalationsDir,
  teamLastSessionFile,
  teamSessionsRoot,
  workspaceEnvDir,
  workspaceMemoryDir,
} from './paths.js'
import type { Message } from '@mariozechner/pi-ai'
import type { SessionMeta } from '../types.js'

export async function readSessionMeta(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
): Promise<SessionMeta | null> {
  try {
    const raw = await fs.readFile(
      sessionMetaFile(root, workspaceId, teamName, sessionId),
      'utf8',
    )
    return JSON.parse(raw) as SessionMeta
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export async function writeSessionMeta(
  root: string,
  workspaceId: string,
  teamName: string,
  meta: SessionMeta,
): Promise<void> {
  const dir = sessionDir(root, workspaceId, teamName, meta.id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    sessionMetaFile(root, workspaceId, teamName, meta.id),
    JSON.stringify(meta, null, 2),
    'utf8',
  )
}

export async function readMessages(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
): Promise<Message[]> {
  try {
    const raw = await fs.readFile(
      sessionMessagesFile(root, workspaceId, teamName, sessionId),
      'utf8',
    )
    return raw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as Message)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

/**
 * Append one message to messages.jsonl (one JSON object per line).
 * Caller must ensure the session dir exists.
 */
export async function appendMessage(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
  message: Message,
): Promise<void> {
  const file = sessionMessagesFile(root, workspaceId, teamName, sessionId)
  await fs.appendFile(file, JSON.stringify(message) + '\n', 'utf8')
}

/**
 * Append one event to events.jsonl. Sync-style append for crash safety.
 * The event persister wraps this in a try/catch — losing one event line
 * to a bad write is preferable to crashing the run.
 */
export async function appendEventLine(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
  line: string,
): Promise<void> {
  const file = sessionEventsFile(root, workspaceId, teamName, sessionId)
  await fs.appendFile(file, line + '\n', 'utf8')
}

export async function readLastSessionId(
  root: string,
  workspaceId: string,
  teamName: string,
): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      teamLastSessionFile(root, workspaceId, teamName),
      'utf8',
    )
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export async function writeLastSessionId(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
): Promise<void> {
  const file = teamLastSessionFile(root, workspaceId, teamName)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, sessionId + '\n', 'utf8')
}

export async function listSessions(
  root: string,
  workspaceId: string,
  teamName: string,
): Promise<string[]> {
  try {
    const entries = await fs.readdir(teamSessionsRoot(root, workspaceId, teamName))
    return entries.sort()
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

/**
 * Build the sandbox symlink tree for a session.
 *
 * Layout:
 *   sandbox/env/    → ../../../../env/    (workspace's env, RO)
 *   sandbox/memory/ → ../../../../memory/ (workspace's memory, RW)
 *   sandbox/traces/ → ../traces/          (this session's traces, RW)
 *
 * `env` is symlinked, not chmod'd — the spike accepts the agent could
 * write env files via direct path manipulation. A future iteration adds
 * a true MountableFs overlay or per-file chmod.
 */
export async function buildSandbox(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
): Promise<string> {
  const sbDir = sessionSandboxDir(root, workspaceId, teamName, sessionId)
  const tracesDir = sessionTracesDir(root, workspaceId, teamName, sessionId)
  const escDir = sessionEscalationsDir(root, workspaceId, teamName, sessionId)
  await fs.mkdir(sbDir, { recursive: true })
  await fs.mkdir(tracesDir, { recursive: true })
  await fs.mkdir(escDir, { recursive: true })

  await ensureSymlink(workspaceEnvDir(root, workspaceId), path.join(sbDir, 'env'))
  await ensureSymlink(workspaceMemoryDir(root, workspaceId), path.join(sbDir, 'memory'))
  await ensureSymlink(tracesDir, path.join(sbDir, 'traces'))

  return sbDir
}

async function ensureSymlink(target: string, linkPath: string): Promise<void> {
  // Resolve target to an absolute path so the symlink works from inside
  // the sandbox cwd regardless of relative-path semantics.
  const abs = path.resolve(target)
  // Make sure target dir exists so the symlink isn't dangling.
  await fs.mkdir(abs, { recursive: true })
  try {
    const existing = await fs.readlink(linkPath)
    if (path.resolve(path.dirname(linkPath), existing) === abs) return
    await fs.unlink(linkPath)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  await fs.symlink(abs, linkPath)
}

/**
 * Persist a tool result (command, stdio, exit) for one bash call. Lands
 * at sessions/<id>/traces/<toolCallId>/result.json. Existence indicates
 * the tool ran; absence means the tool was blocked or never started.
 */
export async function writeToolResult(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
  toolCallId: string,
  result: { command: string; rationale: string; stdout: string; stderr: string; exitCode: number },
): Promise<void> {
  const dir = path.join(sessionTracesDir(root, workspaceId, teamName, sessionId), toolCallId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
}

/**
 * Persist a screenshot byte buffer to the per-tool-call traces dir.
 */
export async function writeScreenshot(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
  toolCallId: string,
  kind: 'before' | 'annotated' | 'after',
  bytes: Buffer | Uint8Array,
): Promise<string> {
  const dir = path.join(sessionTracesDir(root, workspaceId, teamName, sessionId), toolCallId)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${kind}.png`)
  await fs.writeFile(file, bytes)
  return file
}

/**
 * Sync existence check used by the escalate tool's polling loop.
 * Avoids the await-fs-stat overhead for every poll tick.
 */
export function existsSync(p: string): boolean {
  try {
    fsSync.accessSync(p)
    return true
  } catch {
    return false
  }
}
