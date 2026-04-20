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
 * Find the kind of a pending registration by searching both host and client lists.
 */
async function findRegistrationKind(
  client: RegistryClient,
  id: string
): Promise<"host" | "client" | null> {
  const [hosts, clients] = await Promise.all([
    client.listPendingHosts(),
    client.listPendingClients(),
  ]);
  if (hosts.some((r) => r.id === id)) return "host";
  if (clients.some((r) => r.id === id)) return "client";
  return null;
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
      const kind = await findRegistrationKind(client, id);
      if (!kind) {
        console.error(`No pending registration found with id ${id}`);
        process.exit(1);
      }
      try {
        if (kind === "host") {
          await client.approveHost(id);
        } else {
          await client.approveClient(id);
        }
        console.error(`Approved ${kind} registration ${id}`);
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
      const kind = await findRegistrationKind(client, id);
      if (!kind) {
        console.error(`No pending registration found with id ${id}`);
        process.exit(1);
      }
      try {
        if (kind === "host") {
          await client.rejectHost(id);
        } else {
          await client.rejectClient(id);
        }
        console.error(`Rejected ${kind} registration ${id}`);
      } catch (err) {
        console.error(`Failed to reject ${id}: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return reg;
}
