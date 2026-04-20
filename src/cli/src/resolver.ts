import { RegistryClient } from "./registry-client.js";

export interface ResolvedPhone {
  /** Base URL of the host server (https://fqdn:port) */
  hostUrl: string;
  /** Host-local phone ID (used in /phones/{id}/api/... paths) */
  localPhoneId: string;
}

interface CachedResolution {
  resolved: ResolvedPhone;
  resolvedAt: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CachedResolution>();

/**
 * Resolve a registry phone ID to its host's base URL and host-local phone ID.
 *
 * Steps:
 * 1. GET /admin/phones/{id} from registry -> host fqdn + port
 * 2. GET /phones from host server -> find entry with matching registry_id
 * 3. Cache result for 5 minutes
 */
export async function resolvePhone(
  client: RegistryClient,
  phoneId: string
): Promise<ResolvedPhone> {
  const cached = cache.get(phoneId);
  if (cached && Date.now() - cached.resolvedAt < TTL_MS) {
    return cached.resolved;
  }

  // Step 1: Get phone detail from registry (includes host info)
  const detail = await client.getPhone(phoneId);
  const host = detail.host as
    | { fqdn?: string | null; tailscale_ip?: string | null; api_port?: number }
    | null
    | undefined;

  const hostAddr = host?.fqdn || host?.tailscale_ip;
  if (!hostAddr) {
    throw new Error(
      `Phone ${phoneId} has no connected host (status: ${detail.status})`
    );
  }

  const apiPort = host?.api_port ?? 8080;
  const hostUrl = `https://${hostAddr}:${apiPort}`;

  // Step 2: Query host server for local phone ID
  // The host stores phones with local IDs (e.g. "phone-r5ct60sd") and maps
  // them to registry IDs. We need the local ID for API paths.
  let localPhoneId: string;
  try {
    const phonesRes = await fetch(`${hostUrl}/phones`, {
      headers: { "Accept": "application/json" },
    });
    if (phonesRes.ok) {
      const phones = (await phonesRes.json()) as Array<{
        id: string;
        registry_id?: string | null;
      }>;
      // Match by registry_id first
      const match = phones.find((p) => p.registry_id === phoneId);
      if (match) {
        localPhoneId = match.id;
      } else {
        // Try direct ID match (in case local ID == registry ID)
        const directMatch = phones.find((p) => p.id === phoneId);
        localPhoneId = directMatch?.id ?? phoneId;
      }
    } else {
      // Fallback: use registry ID as-is
      localPhoneId = phoneId;
    }
  } catch {
    // Host unreachable — use registry ID as-is
    localPhoneId = phoneId;
  }

  const resolved: ResolvedPhone = { hostUrl, localPhoneId };
  cache.set(phoneId, { resolved, resolvedAt: Date.now() });

  return resolved;
}

/** Clear the resolution cache (useful after phone use / reconnect). */
export function clearResolverCache(): void {
  cache.clear();
}
