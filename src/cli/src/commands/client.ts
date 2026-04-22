import { Command } from "commander";
import { resolveConfig } from "../config.js";
import { RegistryClient } from "../registry-client.js";

function getRegistryClient(opts: { registry?: string }): RegistryClient {
  const resolved = resolveConfig({ registry: opts.registry });
  if (!resolved.registryUrl || !resolved.token) {
    console.error("Not registered. Run `otacon auth register` first.");
    process.exit(1);
  }
  return new RegistryClient(resolved.registryUrl, resolved.token);
}

/**
 * Approved CLI/admin clients exist as admin-scope tokens in the registry.
 * `otacon client list` filters tokens by scope=admin and excludes revoked entries.
 */
export function clientCommands(parentOpts: () => { registry?: string }): Command {
  const client = new Command("client").description("Admin client (CLI/UI) management");

  client
    .command("list")
    .description("List active admin clients")
    .option("--all", "include revoked clients")
    .action(async (opts: { all?: boolean }) => {
      const c = getRegistryClient(parentOpts());
      const tokens = await c.listTokens();
      const filtered = tokens.filter(
        (t) => t.scope === "admin" && (opts.all || !t.revoked_at)
      );
      console.log(JSON.stringify(filtered, null, 2));
    });

  client
    .command("revoke")
    .description("Revoke an admin client token")
    .argument("<id>", "token ID")
    .action(async (id: string) => {
      const c = getRegistryClient(parentOpts());
      await c.revokeToken(id);
      console.log(`Revoked client ${id}`);
    });

  return client;
}
