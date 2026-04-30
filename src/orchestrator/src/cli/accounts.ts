/**
 * `accounts` group — HTTP-backed CLI subcommands (P3-I).
 *
 *   accounts list [--json]
 *   accounts add <id> [--display-name=] [--phone-number=]
 *   accounts show <id> [--json]
 *   accounts env get <id> <file>
 *   accounts env put <id> <file>            # reads stdin
 *   accounts env delete <id> <file>
 */
import * as fs from 'node:fs'
import { makeApiClient } from './api-client.js'

interface Account {
  id: string
  displayName?: string | null
  accountType?: string
  status?: string
  createdAt?: number
}

export async function accountsListCommand(opts: { json?: boolean; url?: string }): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const body = await api.get<{ accounts: Account[] }>('/api/v1/accounts')
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2))
    return
  }
  if (body.accounts.length === 0) {
    console.log('(no accounts)')
    return
  }
  const cols = ['ID', 'DISPLAY NAME', 'TYPE', 'STATUS']
  const rows = body.accounts.map(a => [
    a.id,
    a.displayName ?? '',
    a.accountType ?? '',
    a.status ?? '',
  ])
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)))
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  console.log(fmt(cols))
  console.log(fmt(widths.map(w => '─'.repeat(w))))
  for (const r of rows) console.log(fmt(r))
}

export async function accountsAddCommand(opts: {
  id: string
  displayName?: string
  phoneNumber?: string
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const body = await api.post<{ account: Account }>('/api/v1/accounts', {
    body: { id: opts.id, displayName: opts.displayName, phoneNumber: opts.phoneNumber },
  })
  console.log(`account ${body.account.id} ready (status=${body.account.status ?? 'active'})`)
}

export async function accountsShowCommand(opts: {
  id: string
  json?: boolean
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const body = await api.get<{ account: Account }>(`/api/v1/accounts/${encodeURIComponent(opts.id)}`)
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2))
    return
  }
  console.log(JSON.stringify(body.account, null, 2))
}

export async function accountsEnvGetCommand(opts: {
  id: string
  file: string
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const text = await api.get<string>(
    `/api/v1/accounts/${encodeURIComponent(opts.id)}/env/${encodeURIComponent(opts.file)}`,
    { accept: 'text/markdown' },
  )
  process.stdout.write(typeof text === 'string' ? text : String(text))
}

export async function accountsEnvPutCommand(opts: {
  id: string
  file: string
  /** Path to read content from (`-` or undefined for stdin). */
  content?: string
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const content = opts.content === undefined || opts.content === '-'
    ? await readStdin()
    : fs.readFileSync(opts.content, 'utf-8')
  // PUT env body is raw markdown, not JSON — pass via textBody so the
  // client sets content-type=text/markdown without JSON-wrapping.
  const res = await api.raw(
    `/api/v1/accounts/${encodeURIComponent(opts.id)}/env/${encodeURIComponent(opts.file)}`,
    { method: 'PUT', textBody: content, contentType: 'text/markdown', accept: 'application/json' },
  )
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`PUT env failed: HTTP ${res.status}\n${t.slice(0, 300)}`)
  }
  const body = (await res.json()) as { ok: boolean; bytes: number }
  console.log(`wrote ${body.bytes} bytes to ${opts.file}`)
}

export async function accountsEnvDeleteCommand(opts: {
  id: string
  file: string
  url?: string
}): Promise<void> {
  const api = makeApiClient({ url: opts.url })
  const body = await api.del<{ ok: boolean; deleted: boolean }>(
    `/api/v1/accounts/${encodeURIComponent(opts.id)}/env/${encodeURIComponent(opts.file)}`,
  )
  console.log(`${opts.file}: deleted=${body.deleted}`)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) {
    chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
  }
  return Buffer.concat(chunks).toString('utf-8')
}
