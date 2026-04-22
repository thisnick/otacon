import { Command } from "commander";
import { resolveConfig } from "../config.js";
import { RegistryClient } from "../registry-client.js";
import { printList, printDetail, colorStatus } from "../format.js";

function getRegistryClient(opts: { registry?: string }): RegistryClient {
  const resolved = resolveConfig({ registry: opts.registry });
  if (!resolved.registryUrl || !resolved.token) {
    console.error("Not registered. Run `otacon auth register` first.");
    process.exit(1);
  }
  return new RegistryClient(resolved.registryUrl, resolved.token);
}

export function hostCommands(parentOpts: () => { registry?: string }): Command {
  const host = new Command("host").description("Host management");

  host
    .command("list")
    .description("List all hosts (default: table; use --json for raw JSON)")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = getRegistryClient(parentOpts());
      const hosts = await client.listHosts();
      printList(hosts, [
        { header: "ID", get: (h) => h.id },
        { header: "STATUS", get: (h) => colorStatus(h.status) },
        { header: "FQDN", get: (h) => h.fqdn },
        { header: "IP", get: (h) => h.tailscale_ip },
        { header: "PORT", get: (h) => h.api_port },
        { header: "LAST HEARTBEAT", get: (h) => h.last_heartbeat },
      ], { json: opts.json });
    });

  host
    .command("status")
    .description("Show host details")
    .argument("<id>", "host ID")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = getRegistryClient(parentOpts());
      const host = await client.getHost(id);
      printDetail(host as unknown as Record<string, unknown>, { json: opts.json });
    });

  host
    .command("delete")
    .description("Forget a host (re-registered on next heartbeat if alive)")
    .argument("<id>", "host ID")
    .action(async (id: string) => {
      const client = getRegistryClient(parentOpts());
      await client.deleteHost(id);
      console.log(`Deleted host ${id}`);
    });

  return host;
}
