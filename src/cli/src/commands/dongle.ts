import { Command } from "commander";
import { resolveConfig } from "../config.js";
import { RegistryClient } from "../registry-client.js";
import { printList, colorStatus } from "../format.js";

function getRegistryClient(opts: { registry?: string }): RegistryClient {
  const resolved = resolveConfig({ registry: opts.registry });
  if (!resolved.registryUrl || !resolved.token) {
    console.error("Not registered. Run `otacon auth register` first.");
    process.exit(1);
  }
  return new RegistryClient(resolved.registryUrl, resolved.token);
}

export function dongleCommands(
  parentOpts: () => { registry?: string },
  name = "dongles"
): Command {
  const dongle = new Command(name).description("Dongle management");

  dongle
    .command("list")
    .description("List all dongles (default: table; use --json for raw JSON)")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = getRegistryClient(parentOpts());
      const dongles = await client.listDongles();
      printList(dongles, [
        { header: "ID", get: (d) => d.id },
        { header: "BT MAC", get: (d) => d.bt_mac },
        { header: "HCI", get: (d) => d.hci_device },
        { header: "HOST", get: (d) => d.host_id },
        { header: "PHONE", get: (d) => d.phone_id ?? "spare" },
        { header: "STATUS", get: (d) => colorStatus(d.status) },
      ], { json: opts.json });
    });

  dongle
    .command("delete")
    .description("Forget a dongle (re-registered on next heartbeat if alive)")
    .argument("<id>", "dongle ID")
    .action(async (id: string) => {
      const client = getRegistryClient(parentOpts());
      await client.deleteDongle(id);
      console.log(`Deleted dongle ${id}`);
    });

  return dongle;
}
