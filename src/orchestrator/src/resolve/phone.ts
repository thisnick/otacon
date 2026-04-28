/**
 * Phone resolver: maps a credential phone number to the OtaconClient base URL
 * by querying the otacon registry API, then querying the host for the
 * host-local phone ID.
 *
 * Resolution path:
 *   phone_number → registry phones → phone.host_id → host.address
 *                → GET host /phones (match by adb_serial)
 *                → host-local phone ID
 *
 * IMPORTANT: registry phone ID (e.g. `phone-4`) and host-local phone ID
 * (e.g. `phone-r5ct60sd`) are different. The host's API only serves the
 * local ID — the registry ID 404s. Always use `localPhoneId` in URLs.
 *
 * Config is read from env vars or ~/.otacon/config.toml (same as the CLI).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

interface ResolvedPhone {
  /** Registry phone ID (e.g. "phone-4"). For registry-side bookkeeping only. */
  phoneId: string
  /** Host-local phone ID (e.g. "phone-r5ct60sd"). USE THIS in URLs. */
  localPhoneId: string
  /** Base URL of the host (https://fqdn:port). NOT including /phones/<id>. */
  hostUrl: string
  /**
   * Full base URL for the OtaconClient: ${hostUrl}/phones/${localPhoneId}.
   * Pre-built for convenience.
   */
  baseUrl: string
}

function loadOtaconConfig(): { registryUrl?: string; token?: string } {
  const registryUrl = process.env.OTACON_REGISTRY_URL
  const token = process.env.OTACON_TOKEN

  if (registryUrl && token) return { registryUrl, token }

  // Fall back to ~/.otacon/config.toml
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

/**
 * Resolve a phone number to the OtaconClient base URL via the registry.
 * Throws if the phone number can't be found or the host is unreachable.
 *
 * Returns the host-local phone ID (used in URLs) AND the registry phone ID
 * (kept for diagnostics — never put in a URL).
 */
export async function resolvePhone(phoneNumber: string): Promise<ResolvedPhone> {
  const { registryUrl, token } = loadOtaconConfig()
  if (!registryUrl) throw new Error('Cannot resolve phone: OTACON_REGISTRY_URL not set and ~/.otacon/config.toml has no registry_url')
  if (!token) throw new Error('Cannot resolve phone: OTACON_TOKEN not set and ~/.otacon/config.toml has no token')

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
  }

  // 1. List phones and find by phone_number
  const phonesRes = await fetch(`${registryUrl}/api/v1/admin/phones`, { headers })
  if (!phonesRes.ok) throw new Error(`Registry phones list failed: HTTP ${phonesRes.status}`)
  const phones = await phonesRes.json() as Array<{
    id: string
    phone_number?: string | null
    host_id?: string | null
    adb_serial?: string | null
    status: string
  }>

  const phone = phones.find(p => p.phone_number === phoneNumber && p.status === 'connected')
    || phones.find(p => p.phone_number === phoneNumber)
  if (!phone) throw new Error(`No phone found with number "${phoneNumber}" in registry`)
  if (!phone.host_id) throw new Error(`Phone "${phone.id}" has no host_id — not connected to any host`)

  // 2. Get host details
  const hostRes = await fetch(`${registryUrl}/api/v1/admin/hosts/${encodeURIComponent(phone.host_id)}`, { headers })
  if (!hostRes.ok) throw new Error(`Registry host lookup failed for "${phone.host_id}": HTTP ${hostRes.status}`)
  const host = await hostRes.json() as {
    id: string
    address?: string | null
    api_port: number
  }
  if (!host.address) throw new Error(`Host "${host.id}" has no address`)

  const hostUrl = `https://${host.address}:${host.api_port}`

  // 3. Query the host for its local phone list and resolve the registry
  // ID to the host-local ID. Without this, OtaconClient URLs use the
  // wrong ID and every request 404s. Match by adb_serial (most reliable),
  // then by registry_id, then direct ID match.
  let localPhoneId = phone.id
  try {
    const hostPhonesRes = await fetch(`${hostUrl}/phones`, {
      headers: { Accept: 'application/json' },
    })
    if (hostPhonesRes.ok) {
      const hostPhones = (await hostPhonesRes.json()) as Array<{
        id: string
        adb_serial?: string
        registry_id?: string | null
      }>
      const serialMatch = phone.adb_serial
        ? hostPhones.find(p => p.adb_serial === phone.adb_serial)
        : undefined
      if (serialMatch) {
        localPhoneId = serialMatch.id
      } else {
        const regMatch = hostPhones.find(p => p.registry_id === phone.id)
        if (regMatch) {
          localPhoneId = regMatch.id
        } else {
          const directMatch = hostPhones.find(p => p.id === phone.id)
          if (directMatch) localPhoneId = directMatch.id
        }
      }
    }
  } catch {
    // If the host is unreachable, fall back to using the registry ID.
    // OtaconClient calls will 404 — but that's a clearer signal than a
    // silent retry on the wrong endpoint.
  }

  const baseUrl = `${hostUrl}/phones/${localPhoneId}`

  return { phoneId: phone.id, localPhoneId, hostUrl, baseUrl }
}
