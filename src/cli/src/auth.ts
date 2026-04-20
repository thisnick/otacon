import { loadConfig, saveConfig, resolveConfig } from "./config.js";

/**
 * Register with a registry: POST /api/v1/clients/register, then long-poll
 * /api/v1/clients/poll/{id} until approved or rejected.
 */
export async function registerClient(registryUrl: string): Promise<string> {
  const hostname = (await import("os")).hostname();

  const regRes = await fetch(`${registryUrl}/api/v1/clients/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: hostname, hostname }),
  });
  if (!regRes.ok) {
    const body = await regRes.text();
    throw new Error(`Registration failed: HTTP ${regRes.status} ${body}`);
  }
  const { pending_id } = (await regRes.json()) as { pending_id: string };

  console.error(`Registration submitted (id: ${pending_id})`);
  console.error("Waiting for admin approval...");

  // Long-poll until approved or rejected
  while (true) {
    const pollRes = await fetch(
      `${registryUrl}/api/v1/clients/poll/${pending_id}`,
      { method: "POST" }
    );

    if (!pollRes.ok) {
      throw new Error(`Poll failed: HTTP ${pollRes.status}`);
    }

    const result = (await pollRes.json()) as {
      status: string;
      token?: string;
    };

    if (result.status === "approved" && result.token) {
      return result.token;
    }

    if (result.status === "rejected") {
      throw new Error("Registration was rejected by admin");
    }

    // Still pending — wait before polling again
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Save a token + registry URL to the config file. */
export function saveAuth(registryUrl: string, token: string): void {
  const config = loadConfig();
  config.registry_url = registryUrl;
  config.token = token;
  saveConfig(config);
}

/** Remove the token from config. */
export function removeAuth(): void {
  const config = loadConfig();
  delete config.token;
  saveConfig(config);
}

/** Get a summary of current auth state for "whoami". */
export function whoami(): {
  registryUrl?: string;
  tokenPrefix?: string;
  activePhone?: string;
} {
  const resolved = resolveConfig({});
  return {
    registryUrl: resolved.registryUrl,
    tokenPrefix: resolved.token ? resolved.token.slice(0, 16) + "..." : undefined,
    activePhone: resolved.activePhone,
  };
}
