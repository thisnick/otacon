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

  reg
    .command("approve-all")
    .description("Approve all pending registrations (hosts + clients)")
    .option("--hosts-only", "only approve pending hosts")
    .option("--clients-only", "only approve pending clients")
    .action(async (opts: { hostsOnly?: boolean; clientsOnly?: boolean }) => {
      const client = getRegistryClient(parentOpts());
      const [hosts, clients] = await Promise.all([
        client.listPendingHosts(),
        client.listPendingClients(),
      ]);
      const targets: { id: string; kind: "host" | "client" }[] = [];
      if (!opts.clientsOnly) {
        for (const r of hosts.filter((r) => r.status === "pending")) {
          targets.push({ id: r.id, kind: "host" });
        }
      }
      if (!opts.hostsOnly) {
        for (const r of clients.filter((r) => r.status === "pending")) {
          targets.push({ id: r.id, kind: "client" });
        }
      }
      if (targets.length === 0) {
        console.error("No pending registrations to approve");
        return;
      }
      let ok = 0;
      let failed = 0;
      for (const t of targets) {
        try {
          if (t.kind === "host") await client.approveHost(t.id);
          else await client.approveClient(t.id);
          console.error(`Approved ${t.kind} ${t.id}`);
          ok++;
        } catch (err) {
          console.error(`Failed to approve ${t.kind} ${t.id}: ${(err as Error).message}`);
          failed++;
        }
      }
      console.error(`\nDone: ${ok} approved, ${failed} failed`);
      if (failed > 0) process.exit(1);
    });

  reg
    .command("reject-all")
    .description("Reject all pending registrations (hosts + clients)")
    .option("--hosts-only", "only reject pending hosts")
    .option("--clients-only", "only reject pending clients")
    .action(async (opts: { hostsOnly?: boolean; clientsOnly?: boolean }) => {
      const client = getRegistryClient(parentOpts());
      const [hosts, clients] = await Promise.all([
        client.listPendingHosts(),
        client.listPendingClients(),
      ]);
      const targets: { id: string; kind: "host" | "client" }[] = [];
      if (!opts.clientsOnly) {
        for (const r of hosts.filter((r) => r.status === "pending")) {
          targets.push({ id: r.id, kind: "host" });
        }
      }
      if (!opts.hostsOnly) {
        for (const r of clients.filter((r) => r.status === "pending")) {
          targets.push({ id: r.id, kind: "client" });
        }
      }
      if (targets.length === 0) {
        console.error("No pending registrations to reject");
        return;
      }
      let ok = 0;
      let failed = 0;
      for (const t of targets) {
        try {
          if (t.kind === "host") await client.rejectHost(t.id);
          else await client.rejectClient(t.id);
          console.error(`Rejected ${t.kind} ${t.id}`);
          ok++;
        } catch (err) {
          console.error(`Failed to reject ${t.kind} ${t.id}: ${(err as Error).message}`);
          failed++;
        }
      }
      console.error(`\nDone: ${ok} rejected, ${failed} failed`);
      if (failed > 0) process.exit(1);
    });

  return reg;
}
