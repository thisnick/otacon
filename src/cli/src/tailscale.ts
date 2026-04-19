import { execSync } from "child_process";

let cachedFqdn: Record<string, string> = {};

/**
 * Resolve a Tailscale short hostname to its FQDN.
 * Falls back to the short hostname if tailscale is unavailable.
 */
export function tsFqdn(hostname: string): string {
  if (cachedFqdn[hostname]) return cachedFqdn[hostname];

  try {
    const json = execSync("tailscale status --json", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const status = JSON.parse(json);
    const peer = Object.values(status.Peer as Record<string, any>).find(
      (p: any) => p.HostName === hostname
    );
    if (peer) {
      const fqdn = (peer as any).DNSName.replace(/\.$/, "");
      cachedFqdn[hostname] = fqdn;
      return fqdn;
    }
  } catch {}

  cachedFqdn[hostname] = hostname;
  return hostname;
}

/**
 * Build a Pi fleet-node URL from the Tailscale FQDN.
 */
export function piUrl(hostname = "otacon-pi", port = 8080): string {
  return `https://${tsFqdn(hostname)}:${port}`;
}
