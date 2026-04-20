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

export function hostCommands(parentOpts: () => { registry?: string }): Command {
  const host = new Command("host").description("Host management");

  host
    .command("list")
    .description("List all hosts")
    .action(async () => {
      const client = getRegistryClient(parentOpts());
      const hosts = await client.listHosts();
      console.log(JSON.stringify(hosts, null, 2));
    });

  host
    .command("status")
    .description("Show host details")
    .argument("<id>", "host ID")
    .action(async (id: string) => {
      const client = getRegistryClient(parentOpts());
      const host = await client.getHost(id);
      console.log(JSON.stringify(host, null, 2));
    });

  return host;
}
