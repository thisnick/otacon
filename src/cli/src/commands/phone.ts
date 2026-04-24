import { Command } from "commander";
import { resolveConfig, loadConfig, saveConfig } from "../config.js";
import { RegistryClient, type PhoneConfig } from "../registry-client.js";
import { printList, printDetail, colorStatus } from "../format.js";

type ParentOpts = { registry?: string; phone?: string };

function getRegistryClient(opts: ParentOpts): RegistryClient {
  const resolved = resolveConfig({ registry: opts.registry });
  if (!resolved.registryUrl || !resolved.token) {
    console.error("Not registered. Run `otacon auth register` first.");
    process.exit(1);
  }
  return new RegistryClient(resolved.registryUrl, resolved.token);
}

function resolvePhoneId(parentOpts: () => ParentOpts, explicitId?: string): string {
  if (explicitId) return explicitId;
  const opts = parentOpts();
  const resolved = resolveConfig({ registry: opts.registry, phone: opts.phone });
  if (!resolved.activePhone) {
    console.error("No phone specified. Pass an ID or run `otacon phones use <id>`");
    process.exit(1);
  }
  return resolved.activePhone;
}

function desired(value: unknown): string {
  if (value === null || value === undefined) return "-";
  return value ? "on" : "off";
}

export function phoneCommands(
  parentOpts: () => ParentOpts,
  name = "phones"
): Command {
  const phone = new Command(name).description("Phone management");

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
        { header: "BT", get: (p) => desired(p.config?.bluetooth_enabled) },
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
    .command("status")
    .description("Show registry status and Bluetooth pairing policy for a phone")
    .argument("[id]", "phone ID (defaults to active phone)")
    .option("--json", "output as JSON")
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      const phoneId = resolvePhoneId(parentOpts, id);
      const client = getRegistryClient(parentOpts());
      const detail = await client.getPhone(phoneId);
      if (opts.json) {
        printDetail(detail, { json: true });
        return;
      }
      const config = (detail.config ?? {}) as Partial<PhoneConfig>;
      const host = (detail.host ?? null) as { id?: string; address?: string; api_port?: number } | null;
      const sims = Array.isArray(detail.sims) ? detail.sims : [];
      printDetail({
        id: detail.id,
        status: detail.status,
        host: host?.id,
        address: host?.address,
        api_port: host?.api_port,
        model: detail.model,
        adb_serial: detail.adb_serial,
        bluetooth_pairing: desired(config.bluetooth_enabled),
        adapter_mac: detail.adapter_mac,
        phone_number: detail.phone_number,
        sims: sims.length,
        updated_at: detail.updated_at,
      });
    });

  phone
    .command("location")
    .description("Show host FQDN and port for a phone")
    .argument("[id]", "phone ID (defaults to active phone)")
    .option("--json", "output as JSON")
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      const phoneId = resolvePhoneId(parentOpts, id);
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

  return phone;
}
