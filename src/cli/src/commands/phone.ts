import { Command } from "commander";
import { resolveConfig, loadConfig, saveConfig } from "../config.js";
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

export function phoneCommands(parentOpts: () => { registry?: string }): Command {
  const phone = new Command("phone").description("Phone management");

  phone
    .command("list")
    .description("List phones (default: table; use --json for raw JSON)")
    .option("--all", "show all phones")
    .option("--connected", "show only connected phones")
    .option("--host <id>", "filter by host ID")
    .option("--json", "output as JSON instead of a table")
    .action(async (opts: { all?: boolean; connected?: boolean; host?: string; json?: boolean }) => {
      const client = getRegistryClient(parentOpts());
      const resolved = resolveConfig({ registry: parentOpts().registry });
      const activePhone = resolved.activePhone;
      let phones = await client.listPhones();
      if (opts.connected) {
        phones = phones.filter((p) => p.status === "connected");
      }
      if (opts.host) {
        phones = phones.filter((p) => p.host_id === opts.host);
      }
      printList(phones, [
        { header: " ", get: (p) => (p.id === activePhone ? "*" : " ") },
        { header: "ID", get: (p) => p.id },
        { header: "MODEL", get: (p) => p.model },
        { header: "SERIAL", get: (p) => p.adb_serial },
        { header: "STATUS", get: (p) => colorStatus(p.status) },
        { header: "HOST", get: (p) => p.host_id },
        { header: "ADAPTER", get: (p) => p.adapter_mac },
      ], { json: opts.json });
    });

  phone
    .command("use")
    .description("Set the active phone")
    .argument("<phone-id>", "phone ID to make active")
    .action((phoneId: string) => {
      const config = loadConfig();
      config.active_phone = phoneId;
      saveConfig(config);
      console.error(`Active phone set to ${phoneId}`);
    });

  phone
    .command("delete")
    .description("Delete a phone from the registry (forget semantics)")
    .argument("<id>", "phone ID")
    .action(async (id: string) => {
      const client = getRegistryClient(parentOpts());
      await client.deletePhone(id);
      console.error(`Deleted phone ${id}`);
    });

  phone
    .command("location")
    .description("Show host FQDN and port for a phone")
    .argument("[id]", "phone ID (defaults to active phone)")
    .option("--json", "output as JSON")
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      const resolved = resolveConfig({ registry: parentOpts().registry });
      const phoneId = id || resolved.activePhone;
      if (!phoneId) {
        console.error("No phone specified. Pass an ID or run `otacon phone use <id>`");
        process.exit(1);
      }
      const client = getRegistryClient(parentOpts());
      const detail = await client.getPhone(phoneId);
      const host = detail.host as { address?: string; api_port?: number } | null;
      if (host?.address) {
        printDetail({ address: host.address, api_port: host.api_port }, { json: opts.json });
      } else {
        console.error(`Phone ${phoneId} has no connected host`);
        process.exit(1);
      }
    });

  phone
    .command("config")
    .description("Get or set phone config")
    .argument("[action]", "get or set", "get")
    .argument("[kv...]", "key=value pairs for set")
    .action(async (action: string, kv: string[]) => {
      const resolved = resolveConfig({ registry: parentOpts().registry });
      const phoneId = resolved.activePhone;
      if (!phoneId) {
        console.error("No active phone. Run `otacon phone use <id>` first.");
        process.exit(1);
      }
      const client = getRegistryClient(parentOpts());
      if (action === "get" || action === "get") {
        const detail = await client.getPhone(phoneId);
        console.log(JSON.stringify(detail.config, null, 2));
      } else if (action === "set" && kv.length > 0) {
        // Not implemented yet — requires PUT to /phones/{id}/config
        console.error("Config set not yet implemented via CLI");
        process.exit(1);
      } else {
        console.error("Usage: otacon phone config [get|set <k=v>]");
        process.exit(1);
      }
    });

  return phone;
}
