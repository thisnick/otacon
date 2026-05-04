/**
 * Phones — read-only registry proxy (Phase I).
 *
 *   GET /api/v1/phones
 *
 * Backend: queries the registry's admin phones endpoint with the
 * orchestrator's admin token, filters to phones with a `phone_number`,
 * and reshapes for the UI's PhoneCombobox.
 *
 * The orchestrator already needs registry credentials to resolve a
 * workspace's `phoneNumber` → host base URL at run-start (see
 * `src/resolve/phone.ts`). This route reuses the same env vars
 * (OTACON_REGISTRY_URL, OTACON_TOKEN, ~/.otacon/config.toml) so deploys
 * don't pick up new config.
 *
 * Returns 502 `phones_unavailable` when the registry is unreachable —
 * surfaces it as a transient infrastructure error rather than a config
 * bug.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Hono } from 'hono'
import { apiError } from '../errors.js'

interface RegistryPhone {
  id: string
  phone_number?: string | null
  host_id?: string | null
  status?: string
}

interface RegistryHost {
  id: string
  display_label?: string | null
  hostname?: string | null
}

export interface PhoneSummary {
  phoneNumber: string
  status: 'online' | 'offline' | 'unreachable'
  registryId: string
  displayLabel: string
  hostId: string | null
}

interface RegistryConfig {
  registryUrl?: string
  token?: string
}

function loadRegistryConfig(): RegistryConfig {
  const registryUrl = process.env.OTACON_REGISTRY_URL
  const token = process.env.OTACON_TOKEN
  if (registryUrl && token) return { registryUrl, token }

  const configPath = path.join(
    process.env.OTACON_CONFIG_DIR || path.join(os.homedir(), '.otacon'),
    'config.toml',
  )
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const get = (key: string): string | undefined => {
      const match = raw.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))
      return match?.[1]
    }
    return {
      registryUrl: registryUrl || get('registry_url'),
      token: token || get('token'),
    }
  } catch {
    return { registryUrl, token }
  }
}

export function makePhonesRoutes(): Hono {
  const app = new Hono()

  app.get('/phones', async (c) => {
    const { registryUrl, token } = loadRegistryConfig()
    if (!registryUrl || !token) {
      return apiError(c, 'phones_unavailable',
        'orchestrator is not configured to reach the registry (missing OTACON_REGISTRY_URL or OTACON_TOKEN)',
        { hasUrl: !!registryUrl, hasToken: !!token })
    }
    let phonesRes: Response
    try {
      phonesRes = await fetch(`${registryUrl}/api/v1/admin/phones`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch (err) {
      return apiError(c, 'phones_unavailable',
        `registry unreachable: ${err instanceof Error ? err.message : String(err)}`,
        { registryUrl })
    }
    if (!phonesRes.ok) {
      return apiError(c, 'phones_unavailable',
        `registry phones list returned HTTP ${phonesRes.status}`,
        { registryUrl, status: phonesRes.status })
    }
    let phones: RegistryPhone[]
    try {
      phones = await phonesRes.json() as RegistryPhone[]
    } catch (err) {
      return apiError(c, 'phones_unavailable',
        `registry phones list returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
        { registryUrl })
    }
    if (!Array.isArray(phones)) {
      return apiError(c, 'phones_unavailable',
        'registry phones list returned a non-array body',
        { registryUrl })
    }

    // Lazy-load host display labels for any phones that need them. The
    // registry doesn't denormalize this onto phones, so we query
    // /admin/hosts only when a phone has a host_id.
    const hostIds = new Set<string>()
    for (const p of phones) {
      if (p.host_id && p.phone_number) hostIds.add(p.host_id)
    }
    const hosts = new Map<string, RegistryHost>()
    if (hostIds.size > 0) {
      try {
        const hostsRes = await fetch(`${registryUrl}/api/v1/admin/hosts`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (hostsRes.ok) {
          const list = await hostsRes.json() as RegistryHost[]
          for (const h of list) hosts.set(h.id, h)
        }
      } catch {
        // Best-effort — fall through with empty hosts map; display label
        // degrades to the phone's registry id.
      }
    }

    const out: PhoneSummary[] = []
    for (const p of phones) {
      if (!p.phone_number) continue
      const host = p.host_id ? hosts.get(p.host_id) : undefined
      const hostLabel = host?.display_label || host?.hostname || p.host_id || ''
      const displayLabel = hostLabel
        ? `${p.phone_number} — ${p.id} (${hostLabel})`
        : `${p.phone_number} — ${p.id}`
      const status: PhoneSummary['status'] = p.status === 'connected'
        ? 'online'
        : p.status === 'disconnected'
          ? 'offline'
          : 'unreachable'
      out.push({
        phoneNumber: p.phone_number,
        status,
        registryId: p.id,
        displayLabel,
        hostId: p.host_id ?? null,
      })
    }
    out.sort((a, b) => a.phoneNumber.localeCompare(b.phoneNumber))
    return c.json(out)
  })

  return app
}
