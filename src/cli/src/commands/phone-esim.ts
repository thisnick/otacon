import { Command } from "commander";
import { getHostClient } from "../host-client.js";
import { printList, printDetail, colorStatus } from "../format.js";

/**
 * Fetch a SIMs endpoint on the host server.
 * getHostClient() already includes the /phones/{localId} prefix,
 * so we just append /api/sims/... to the client's baseUrl.
 */
async function simsFetch(
  opts: { host?: string; phone?: string; registry?: string },
  path: string,
  init?: RequestInit
): Promise<Response> {
  const client = await getHostClient(opts);
  const url = `${client.baseUrl}/api/sims${path}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `HTTP ${res.status}`);
  }
  return res;
}

export function simCommands(
  parentOpts: () => { host?: string; phone?: string; registry?: string },
  name = "sims"
): Command {
  const sims = new Command(name).description("SIM/eSIM management");

  sims
    .command("list")
    .description("List SIM/eSIM profiles (active and disabled)")
    .option("--all", "include historical (stale) physical SIM records")
    .option("--json", "output as JSON instead of a table")
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const path = opts.all ? "?all=true" : "";
      const res = await simsFetch(parentOpts(), path);
      const profiles = (await res.json()) as Array<{
        subId: number;
        iccid: string;
        carrier: string;
        slot: number;
        embedded: boolean;
        enabled: boolean;
        status: string;
        historical?: boolean;
        isDefault: boolean;
      }>;
      printList(profiles, [
        { header: "SUBID", get: (p) => String(p.subId) },
        { header: "CARRIER", get: (p) => p.carrier || "(unknown)" },
        { header: "ICCID", get: (p) => p.iccid },
        { header: "TYPE", get: (p) => (p.embedded ? "eSIM" : "physical") },
        { header: "SLOT", get: (p) => (p.slot < 0 ? "-" : String(p.slot)) },
        { header: "STATUS", get: (p) => colorStatus(p.status) },
        { header: "DEFAULT", get: (p) => (p.isDefault ? "*" : " ") },
      ], { json: opts.json });
    });

  sims
    .command("install")
    .description("Install an eSIM profile")
    .argument("<activation-code>", "activation code (LPA:1$...)")
    .option("--json", "output as JSON")
    .action(async (activationCode: string, opts: { json?: boolean }) => {
      const res = await simsFetch(parentOpts(), "/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activationCode }),
      });
      printDetail(await res.json(), { json: opts.json });
    });

  sims
    .command("delete")
    .description("Delete an eSIM profile")
    .argument("<sub-id>", "subscription ID")
    .option("--json", "output as JSON")
    .action(async (subId: string, opts: { json?: boolean }) => {
      const res = await simsFetch(parentOpts(), "/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subId: parseInt(subId) }),
      });
      printDetail(await res.json(), { json: opts.json });
    });

  sims
    .command("switch")
    .description("Switch active eSIM profile")
    .argument("<sub-id>", "subscription ID")
    .option("--json", "output as JSON")
    .action(async (subId: string, opts: { json?: boolean }) => {
      const res = await simsFetch(parentOpts(), "/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subId: parseInt(subId) }),
      });
      printDetail(await res.json(), { json: opts.json });
    });

  sims
    .command("enable")
    .description("Enable an eSIM profile")
    .argument("<sub-id>", "subscription ID")
    .option("--json", "output as JSON")
    .action(async (subId: string, opts: { json?: boolean }) => {
      const res = await simsFetch(parentOpts(), "/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subId: parseInt(subId), enabled: true }),
      });
      printDetail(await res.json(), { json: opts.json });
    });

  sims
    .command("disable")
    .description("Disable an eSIM profile")
    .argument("<sub-id>", "subscription ID")
    .option("--json", "output as JSON")
    .action(async (subId: string, opts: { json?: boolean }) => {
      const res = await simsFetch(parentOpts(), "/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subId: parseInt(subId), enabled: false }),
      });
      printDetail(await res.json(), { json: opts.json });
    });

  sims
    .command("defaults")
    .description("Get or set SIM defaults")
    .argument("[action]", "get or set", "get")
    .argument("[kv...]", "key=value pairs for set")
    .option("--json", "output as JSON")
    .action(async (action: string, kv: string[], opts: { json?: boolean }) => {
      if (action === "get") {
        const res = await simsFetch(parentOpts(), "/defaults");
        printDetail(await res.json(), { json: opts.json });
      } else if (action === "set" && kv.length > 0) {
        const obj: Record<string, string | number | boolean> = {};
        for (const pair of kv) {
          const [k, ...v] = pair.split("=");
          const raw = v.join("=");
          // Auto-parse numbers and booleans for JSON body
          if (/^-?\d+$/.test(raw)) obj[k] = parseInt(raw, 10);
          else if (raw === "true") obj[k] = true;
          else if (raw === "false") obj[k] = false;
          else obj[k] = raw;
        }
        const res = await simsFetch(parentOpts(), "/defaults", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(obj),
        });
        printDetail(await res.json(), { json: opts.json });
      } else {
        console.error("Usage: otacon sims defaults [get|set <k=v>]");
        process.exit(1);
      }
    });

  return sims;
}
