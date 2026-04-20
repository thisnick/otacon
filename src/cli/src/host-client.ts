import { OtaconClient } from "./client.js";
import { RegistryClient } from "./registry-client.js";
import { resolvePhone } from "./resolver.js";
import { resolveConfig } from "./config.js";
import { piUrl } from "./tailscale.js";

/**
 * Build an OtaconClient for the active phone.
 *
 * Resolution order:
 * 1. --host flag / OTACON_HOST env var (direct mode, no registry)
 * 2. Registry resolver: phone ID → host FQDN + port
 * 3. Fallback: Tailscale FQDN discovery (legacy)
 */
export async function getHostClient(opts: {
  host?: string;
  phone?: string;
  registry?: string;
}): Promise<OtaconClient> {
  // Direct host mode: --host flag or OTACON_HOST env var
  const directHost = opts.host || process.env.OTACON_HOST;
  if (directHost) {
    return new OtaconClient(directHost);
  }

  // Registry mode: resolve phone → host
  const resolved = resolveConfig({ registry: opts.registry, phone: opts.phone });

  if (resolved.registryUrl && resolved.token) {
    const phoneId = resolved.activePhone;
    if (!phoneId) {
      throw new Error(
        "No active phone. Set OTACON_PHONE, pass --phone, or run `otacon phone use <id>`"
      );
    }

    const client = new RegistryClient(resolved.registryUrl, resolved.token);
    const baseUrl = await resolvePhone(client, phoneId);
    return new OtaconClient(baseUrl);
  }

  // Legacy fallback: Tailscale FQDN
  return new OtaconClient(piUrl());
}
