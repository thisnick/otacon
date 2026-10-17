import { OtaconClient } from "./client.js";
import { RegistryClient } from "./registry-client.js";
import { resolvePhone } from "./resolver.js";
import { loadConfig, resolveConfig } from "./config.js";
import { piUrl } from "./tailscale.js";

/**
 * Build an OtaconClient for the active phone.
 *
 * Resolution order:
 * 1. --host flag / OTACON_HOST env var (direct mode: a phone's base URL)
 * 2. A phone link in the config (`otacon link`): the linked host, with
 *    --phone / OTACON_PHONE picking another phone on that host
 * 3. Registry resolver: phone ID → host FQDN + port + local phone ID
 * 4. Fallback: Tailscale FQDN discovery (legacy)
 *
 * In registry mode, the baseUrl includes the /phones/{localId} prefix
 * so all OtaconClient methods hit the correct multi-phone paths.
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

  // Linked to a phone directly (no registry)
  const { link } = loadConfig();
  if (link?.mode === "phone") {
    const phone = opts.phone || process.env.OTACON_PHONE || link.phone;
    return new OtaconClient(`${link.host.replace(/\/+$/, "")}/phones/${encodeURIComponent(phone)}`);
  }

  // Registry mode: resolve phone → host + local ID
  const resolved = resolveConfig({ registry: opts.registry, phone: opts.phone });

  if (resolved.registryUrl && resolved.token) {
    const phoneId = resolved.activePhone;
    if (!phoneId) {
      throw new Error(
        "No active phone. Set OTACON_PHONE, pass --phone, or run `otacon phones use <id>`"
      );
    }

    const client = new RegistryClient(resolved.registryUrl, resolved.token);
    const { hostUrl, localPhoneId } = await resolvePhone(client, phoneId);
    // Include /phones/{localId} prefix so OtaconClient's /api/... paths
    // map to the host server's /phones/{id}/api/... routes
    return new OtaconClient(`${hostUrl}/phones/${encodeURIComponent(localPhoneId)}`);
  }

  // Legacy fallback: Tailscale FQDN
  return new OtaconClient(piUrl());
}
