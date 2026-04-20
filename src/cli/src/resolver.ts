import { RegistryClient } from "./registry-client.js";

interface HostLocation {
  fqdn: string;
  apiPort: number;
  resolvedAt: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, HostLocation>();

/**
 * Resolve a phone ID to its host's base URL via the registry.
 * Results are cached for 5 minutes.
 */
export async function resolvePhone(
  client: RegistryClient,
  phoneId: string
): Promise<string> {
  const cached = cache.get(phoneId);
  if (cached && Date.now() - cached.resolvedAt < TTL_MS) {
    return `https://${cached.fqdn}:${cached.apiPort}`;
  }

  const detail = await client.getPhone(phoneId);
  const host = detail.host as
    | { fqdn?: string; api_port?: number }
    | null
    | undefined;

  if (!host?.fqdn) {
    throw new Error(
      `Phone ${phoneId} has no connected host (status: ${detail.status})`
    );
  }

  const loc: HostLocation = {
    fqdn: host.fqdn,
    apiPort: host.api_port ?? 8080,
    resolvedAt: Date.now(),
  };
  cache.set(phoneId, loc);

  return `https://${loc.fqdn}:${loc.apiPort}`;
}

/** Clear the resolution cache (useful after phone use / reconnect). */
export function clearResolverCache(): void {
  cache.clear();
}
