import { Command } from "commander";
import { resolveConfig } from "../config.js";
import { RegistryClient } from "../registry-client.js";
import { printList } from "../format.js";

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
    .description("List active admin clients (default: table; use --json for raw JSON)")
    .option("--all", "include revoked clients")
    .option("--json", "output as JSON")
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const c = getRegistryClient(parentOpts());
      const tokens = await c.listTokens();
      const filtered = tokens.filter(
        (t) => t.scope === "admin" && (opts.all || !t.revoked_at)
      );
      printList(filtered, [
        { header: "PREFIX", get: (t) => t.token_prefix },
        { header: "NOTE", get: (t) => t.note, maxWidth: 40 },
        { header: "LAST SEEN", get: (t) => t.last_seen_at },
        { header: "REVOKED", get: (t) => t.revoked_at },
      ], { json: opts.json });
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
