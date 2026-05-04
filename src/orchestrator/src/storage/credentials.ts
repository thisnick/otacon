/**
 * Workspace credentials store — opaque JSON blob at
 *   `${dataRoot}/workspaces/<id>/credentials.json`
 *
 * Treated as write-only at the API layer. The HTTP handlers never return
 * the values; they only return a status object listing the top-level
 * keys ("fields_set"). Storage shape is whatever JSON the caller PUTs.
 *
 * The agent reads this file directly out of the workspace dir at run-
 * start; the orchestrator's job here is just to manage the file.
 */
import * as fs from 'node:fs/promises'
import { workspaceCredentialsFile } from './paths.js'

export interface CredentialsStatus {
  hasCredentials: boolean
  fieldsSet: string[]
}

export async function readCredentialsStatus(
  root: string,
  workspaceId: string,
): Promise<CredentialsStatus> {
  try {
    const raw = await fs.readFile(workspaceCredentialsFile(root, workspaceId), 'utf8')
    if (raw.trim().length === 0) return { hasCredentials: false, fieldsSet: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Couldn't parse — treat as opaque, but report no fields.
      return { hasCredentials: true, fieldsSet: [] }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { hasCredentials: true, fieldsSet: [] }
    }
    const keys = Object.keys(parsed as Record<string, unknown>).sort()
    return { hasCredentials: keys.length > 0, fieldsSet: keys }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { hasCredentials: false, fieldsSet: [] }
    }
    throw e
  }
}

export async function writeCredentials(
  root: string,
  workspaceId: string,
  body: unknown,
): Promise<void> {
  const json = JSON.stringify(body, null, 2)
  await fs.writeFile(workspaceCredentialsFile(root, workspaceId), json, 'utf8')
}

/** True if the credentials file existed and was deleted. */
export async function deleteCredentials(
  root: string,
  workspaceId: string,
): Promise<boolean> {
  try {
    await fs.unlink(workspaceCredentialsFile(root, workspaceId))
    return true
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}
