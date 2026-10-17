// Real fleet values for live tests come from fleet.local.json at the repo
// root (git-ignored; see fleet.example.json), so no real phone number is
// committed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

export interface LocalFleet {
  xhsAccountPhone?: string
  [key: string]: unknown
}

export function localFleet(): LocalFleet {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fleet.local.json'), 'utf8')) as LocalFleet
  } catch {
    return {}
  }
}

/** The XHS workspace phone: env, then fleet.local.json, then a placeholder. */
export function xhsAccountPhone(): string {
  return process.env.OTACON_SPIKE_WORKSPACE_PHONE ?? localFleet().xhsAccountPhone ?? '+15555550104'
}
