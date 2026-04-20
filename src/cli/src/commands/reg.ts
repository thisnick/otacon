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

export function regCommands(parentOpts: () => { registry?: string }): Command {
  const reg = new Command("reg").description("Registration management");

  reg
    .command("list")
    .description("List pending registrations (hosts + clients)")
    .action(async () => {
      const client = getRegistryClient(parentOpts());
      const [hosts, clients] = await Promise.all([
        client.listPendingHosts(),
        client.listPendingClients(),
      ]);
      const pending = [
        ...hosts.map((r) => ({ ...r, kind: r.kind ?? "host" })),
        ...clients.map((r) => ({ ...r, kind: r.kind ?? "client" })),
      ].filter((r) => r.status === "pending");
      console.log(JSON.stringify(pending, null, 2));
    });

  reg
    .command("approve")
    .description("Approve a pending registration")
    .argument("<id>", "registration ID")
    .action(async (id: string) => {
      const client = getRegistryClient(parentOpts());
      // Try host first, then client
      try {
        await client.approveHost(id);
        console.error(`Approved host registration ${id}`);
        return;
      } catch {
        // Not a host registration — try client
      }
      try {
        await client.approveClient(id);
        console.error(`Approved client registration ${id}`);
      } catch (err) {
        console.error(`Failed to approve ${id}: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  reg
    .command("reject")
    .description("Reject a pending registration")
    .argument("<id>", "registration ID")
    .action(async (id: string) => {
      const client = getRegistryClient(parentOpts());
      try {
        await client.rejectHost(id);
        console.error(`Rejected host registration ${id}`);
        return;
      } catch {
        // Not a host registration — try client
      }
      try {
        await client.rejectClient(id);
        console.error(`Rejected client registration ${id}`);
      } catch (err) {
        console.error(`Failed to reject ${id}: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return reg;
}
