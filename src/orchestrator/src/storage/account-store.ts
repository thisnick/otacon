/**
 * AccountStore: persisted accounts + credentials + per-account env files.
 *
 * On disk:
 *   accounts/{id}/account.json       — { id, displayName, accountType, status, config, createdAt }
 *   accounts/{id}/credentials.json   — { rows: Credential[] }
 *   accounts/{id}/env/{relPath}      — read/write of free-form env content (persona.md, etc.)
 *   accounts/{id}/workspace/         — agent's RW workspace; managed by the sandbox FS adapter
 *
 * No SQL. No external deps. Listing walks `accounts/*`.
 */
import * as fs from 'node:fs/promises'
import type { PathLayout } from './paths.js'
import {
  accountDir,
  accountEnvFile,
  accountFile,
  accountWorkspaceDir,
  credentialsFile,
} from './paths.js'
import type {
  Account,
  AccountInput,
  Credential,
  CredentialInput,
} from './types.js'
import { ulid } from './ulid.js'

export interface AccountStore {
  create(input: AccountInput): Promise<Account>
  get(id: string): Promise<Account | null>
  list(): Promise<Account[]>
  update(id: string, patch: Partial<Omit<Account, 'id' | 'createdAt'>>): Promise<Account>

  addCredential(accountId: string, input: CredentialInput): Promise<Credential>
  listCredentials(accountId: string): Promise<Credential[]>
  primaryCredential(accountId: string, credentialType: string): Promise<Credential | null>

  readEnvFile(accountId: string, relPath: string): Promise<string | null>
  writeEnvFile(accountId: string, relPath: string, content: string): Promise<void>

  ensureWorkspace(accountId: string): Promise<string>
}

export class AccountStoreFs implements AccountStore {
  constructor(private layout: PathLayout) {}

  async create(input: AccountInput): Promise<Account> {
    const account: Account = {
      id: input.id,
      displayName: input.displayName ?? null,
      accountType: input.accountType ?? 'xhs',
      status: input.status ?? 'active',
      config: input.config ?? {},
      createdAt: Date.now(),
    }
    await fs.mkdir(accountDir(this.layout, account.id), { recursive: true })

    // Don't clobber an existing record — `create` is idempotent at the file
    // level: if `account.json` already exists we read and return it.
    const existing = await this.get(account.id)
    if (existing) return existing

    await fs.writeFile(accountFile(this.layout, account.id), JSON.stringify(account, null, 2))
    await fs.writeFile(credentialsFile(this.layout, account.id), JSON.stringify({ rows: [] }, null, 2))
    return account
  }

  async get(id: string): Promise<Account | null> {
    try {
      const raw = await fs.readFile(accountFile(this.layout, id), 'utf-8')
      return JSON.parse(raw) as Account
    } catch (e: any) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }

  async list(): Promise<Account[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(this.layout.accountsDir, { withFileTypes: true })
    } catch (e: any) {
      if (e.code === 'ENOENT') return []
      throw e
    }
    const out: Account[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const a = await this.get(entry.name)
      if (a) out.push(a)
    }
    out.sort((a, b) => a.id.localeCompare(b.id))
    return out
  }

  async update(id: string, patch: Partial<Omit<Account, 'id' | 'createdAt'>>): Promise<Account> {
    const current = await this.get(id)
    if (!current) throw new Error(`account "${id}" not found`)
    const next: Account = { ...current, ...patch, id: current.id, createdAt: current.createdAt }
    await fs.writeFile(accountFile(this.layout, id), JSON.stringify(next, null, 2))
    return next
  }

  async addCredential(accountId: string, input: CredentialInput): Promise<Credential> {
    const cred: Credential = {
      id: ulid(),
      credentialType: input.credentialType,
      identifier: input.identifier,
      isPrimary: input.isPrimary ?? false,
      verified: input.verified ?? false,
      secrets: input.secrets ?? null,
      createdAt: Date.now(),
    }
    const file = credentialsFile(this.layout, accountId)
    const existing = await readCredentialsFile(file)

    // (credentialType, identifier) is the natural unique key — return the
    // existing row if one matches, mirroring `onConflictDoNothing`.
    const dup = existing.find(
      r => r.credentialType === cred.credentialType && r.identifier === cred.identifier,
    )
    if (dup) return dup

    // Demote other primaries of the same type if this one claims primary.
    const next = existing.map(r =>
      cred.isPrimary && r.credentialType === cred.credentialType ? { ...r, isPrimary: false } : r,
    )
    next.push(cred)
    await fs.writeFile(file, JSON.stringify({ rows: next }, null, 2))
    return cred
  }

  async listCredentials(accountId: string): Promise<Credential[]> {
    return readCredentialsFile(credentialsFile(this.layout, accountId))
  }

  async primaryCredential(accountId: string, credentialType: string): Promise<Credential | null> {
    const rows = await this.listCredentials(accountId)
    return (
      rows.find(r => r.credentialType === credentialType && r.isPrimary) ??
      rows.find(r => r.credentialType === credentialType) ??
      null
    )
  }

  async readEnvFile(accountId: string, relPath: string): Promise<string | null> {
    try {
      return await fs.readFile(accountEnvFile(this.layout, accountId, relPath), 'utf-8')
    } catch (e: any) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') return null
      throw e
    }
  }

  async writeEnvFile(accountId: string, relPath: string, content: string): Promise<void> {
    const target = accountEnvFile(this.layout, accountId, relPath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf-8')
  }

  async ensureWorkspace(accountId: string): Promise<string> {
    const dir = accountWorkspaceDir(this.layout, accountId)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }
}

import * as path from 'node:path'

async function readCredentialsFile(file: string): Promise<Credential[]> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as { rows?: Credential[] }
    return Array.isArray(parsed.rows) ? parsed.rows : []
  } catch (e: any) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}
