/**
 * Phone resolver: maps a credential phone number to the OtaconClient base URL
 * by querying the otacon registry API.
 *
 * Resolution path: phone_number → registry phones → phone.host_id → host.address → base URL
 *
 * Config is read from env vars or ~/.otacon/config.toml (same as the CLI).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

interface ResolvedPhone {
  phoneId: string
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
    // Simple TOML value extraction (avoid adding @iarna/toml dependency)
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

  // 3. Construct base URL: https://{host.address}:{port}/phones/{phone.id}
  const baseUrl = `https://${host.address}:${host.api_port}/phones/${phone.id}`

  return { phoneId: phone.id, baseUrl }
}
