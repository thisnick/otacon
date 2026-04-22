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

export function dongleCommands(parentOpts: () => { registry?: string }): Command {
  const dongle = new Command("dongle").description("Dongle management");

  dongle
    .command("list")
    .description("List all dongles")
    .action(async () => {
      const client = getRegistryClient(parentOpts());
      const dongles = await client.listDongles();
      console.log(JSON.stringify(dongles, null, 2));
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
