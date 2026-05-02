/**
 * Filesystem layout helpers for `.otacon-data/`.
 *
 *   .otacon-data/
 *     workspaces/<workspaceId>/
 *       workspace.json
 *       credentials.json    (NEVER reachable from agent sandbox)
 *       env/                (RO from agent — symlinked into sandbox)
 *       memory/             (RW from agent — symlinked into sandbox)
 *       teams/<teamName>/
 *         last-session.txt
 *         sessions/<sessionId>/
 *           session.json
 *           messages.jsonl
 *           events.jsonl
 *           sandbox/        (symlink tree, agent's bash cwd)
 *             env/          → ../../../../env/
 *             memory/       → ../../../../memory/
 *             traces/       → ../traces/
 *           traces/<toolCallId>/{before,annotated,after}.png + result.json
 *     teams/<teamName>/
 *       team.json
 *       prompts/*.md
 */
import * as path from 'node:path'

export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORCHESTRATOR_DATA_DIR ?? '.otacon-data'
}

export function workspaceDir(root: string, workspaceId: string): string {
  // Use the literal id as the dir name. Workspace ids are user-defined
  // strings (e.g. "xhs:test") that are valid dir names on POSIX/Mac. If
  // a future workspace id contains `/` or NUL, callers should sanitize
  // before passing in.
  return path.join(root, 'workspaces', workspaceId)
}

export function workspaceFile(root: string, workspaceId: string): string {
  return path.join(workspaceDir(root, workspaceId), 'workspace.json')
}

export function workspaceCredentialsFile(root: string, workspaceId: string): string {
  return path.join(workspaceDir(root, workspaceId), 'credentials.json')
}

export function workspaceEnvDir(root: string, workspaceId: string): string {
  return path.join(workspaceDir(root, workspaceId), 'env')
}

export function workspaceMemoryDir(root: string, workspaceId: string): string {
  return path.join(workspaceDir(root, workspaceId), 'memory')
}

export function teamSessionsRoot(root: string, workspaceId: string, teamName: string): string {
  return path.join(workspaceDir(root, workspaceId), 'teams', teamName, 'sessions')
}

export function teamLastSessionFile(root: string, workspaceId: string, teamName: string): string {
  return path.join(workspaceDir(root, workspaceId), 'teams', teamName, 'last-session.txt')
}

export function sessionDir(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
): string {
  return path.join(teamSessionsRoot(root, workspaceId, teamName), sessionId)
}

export function sessionMetaFile(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
): string {
  return path.join(sessionDir(root, workspaceId, teamName, sessionId), 'session.json')
}

export function sessionMessagesFile(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
): string {
  return path.join(sessionDir(root, workspaceId, teamName, sessionId), 'messages.jsonl')
}

export function sessionEventsFile(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
): string {
  return path.join(sessionDir(root, workspaceId, teamName, sessionId), 'events.jsonl')
}

export function sessionSandboxDir(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
): string {
  return path.join(sessionDir(root, workspaceId, teamName, sessionId), 'sandbox')
}

export function sessionTracesDir(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
): string {
  return path.join(sessionDir(root, workspaceId, teamName, sessionId), 'traces')
}

export function sessionEscalationsDir(
  root: string,
  workspaceId: string,
  teamName: string,
  sessionId: string,
): string {
  return path.join(sessionDir(root, workspaceId, teamName, sessionId), 'escalations')
}

export function teamRoot(root: string, teamName: string): string {
  return path.join(root, 'teams', teamName)
}

export function teamConfigFile(root: string, teamName: string): string {
  return path.join(teamRoot(root, teamName), 'team.json')
}

export function teamPromptFile(root: string, teamName: string, file: string): string {
  return path.join(teamRoot(root, teamName), 'prompts', file)
}
