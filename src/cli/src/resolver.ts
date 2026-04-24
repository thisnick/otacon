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
    | { id?: string; address?: string | null; api_port?: number }
    | null
    | undefined;

  if (!host) {
    throw new Error(
      `Phone ${phoneId} has no connected host (status: ${detail.status})`
    );
  }

  if (!host.address) {
    throw new Error(
      `Phone ${phoneId}: host '${host.id ?? "?"}' has no registered address. ` +
        `The host needs to call POST /api/v1/hosts/identity with its address. ` +
        `Try restarting the host's otacon container so it re-registers.`
    );
  }

  const apiPort = host.api_port ?? 8080;
  const hostUrl = `https://${host.address}:${apiPort}`;

  // Step 2: Query host server for local phone ID
  // The host stores phones with local IDs (e.g. "phone-r5ct60sd") that differ
  // from registry IDs (e.g. "phone-2"). Match by adb_serial (most reliable),
  // then registry_id, then direct ID match.
  const registrySerial = detail.adb_serial as string | undefined;
  let localPhoneId: string;
  try {
    const phonesRes = await fetch(`${hostUrl}/phones`, {
      headers: { "Accept": "application/json" },
    });
    if (phonesRes.ok) {
      const phones = (await phonesRes.json()) as Array<{
        id: string;
        adb_serial?: string;
        registry_id?: string | null;
      }>;
      // Match by adb_serial first (most reliable — always populated on both sides)
      const serialMatch = registrySerial
        ? phones.find((p) => p.adb_serial === registrySerial)
        : undefined;
      if (serialMatch) {
        localPhoneId = serialMatch.id;
      } else {
        // Fall back to registry_id match
        const regMatch = phones.find((p) => p.registry_id === phoneId);
        if (regMatch) {
          localPhoneId = regMatch.id;
        } else {
          // Try direct ID match (in case local ID == registry ID)
          const directMatch = phones.find((p) => p.id === phoneId);
          localPhoneId = directMatch?.id ?? phoneId;
        }
      }
    } else {
      localPhoneId = phoneId;
    }
  } catch {
    localPhoneId = phoneId;
  }

  const resolved: ResolvedPhone = { hostUrl, localPhoneId };
  cache.set(phoneId, { resolved, resolvedAt: Date.now() });

  return resolved;
}

/** Clear the resolution cache (useful after phones use / reconnect). */
export function clearResolverCache(): void {
  cache.clear();
}
