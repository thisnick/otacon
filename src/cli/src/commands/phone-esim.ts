import { Command } from "commander";
import { getHostClient } from "../host-client.js";

/**
 * Fetch an eSIM endpoint on the host server.
 * getHostClient() already includes the /phones/{localId} prefix,
 * so we just append /api/esim/... to the client's baseUrl.
 */
async function esimFetch(
  opts: { host?: string; phone?: string; registry?: string },
  path: string,
  init?: RequestInit
): Promise<Response> {
  const client = await getHostClient(opts);
  const url = `${client.baseUrl}/api/esim${path}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `HTTP ${res.status}`);
  }
  return res;
}

export function phoneEsimCommands(
  parentOpts: () => { host?: string; phone?: string; registry?: string }
): Command {
  const esim = new Command("esim").description("eSIM management");

  esim
    .command("list")
    .description("List eSIM profiles")
    .action(async () => {
      const res = await esimFetch(parentOpts(), "/profiles");
      console.log(JSON.stringify(await res.json(), null, 2));
    });

  esim
    .command("install")
    .description("Install an eSIM profile")
    .argument("<activation-code>", "activation code (LPA:1$...)")
    .action(async (activationCode: string) => {
      const res = await esimFetch(parentOpts(), "/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activationCode }),
      });
      console.log(JSON.stringify(await res.json(), null, 2));
    });

  esim
    .command("delete")
    .description("Delete an eSIM profile")
    .argument("<sub-id>", "subscription ID")
    .action(async (subId: string) => {
      const res = await esimFetch(parentOpts(), "/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription_id: parseInt(subId) }),
      });
      console.log(JSON.stringify(await res.json(), null, 2));
    });

  esim
    .command("switch")
    .description("Switch active eSIM profile")
    .argument("<sub-id>", "subscription ID")
    .action(async (subId: string) => {
      const res = await esimFetch(parentOpts(), "/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription_id: parseInt(subId) }),
      });
      console.log(JSON.stringify(await res.json(), null, 2));
    });

  esim
    .command("enable")
    .description("Enable an eSIM profile")
    .argument("<sub-id>", "subscription ID")
    .action(async (subId: string) => {
      const res = await esimFetch(parentOpts(), "/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription_id: parseInt(subId), enabled: true }),
      });
      console.log(JSON.stringify(await res.json(), null, 2));
    });

  esim
    .command("disable")
    .description("Disable an eSIM profile")
    .argument("<sub-id>", "subscription ID")
    .action(async (subId: string) => {
      const res = await esimFetch(parentOpts(), "/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription_id: parseInt(subId), enabled: false }),
      });
      console.log(JSON.stringify(await res.json(), null, 2));
    });

  esim
    .command("defaults")
    .description("Get or set eSIM defaults")
    .argument("[action]", "get or set", "get")
    .argument("[kv...]", "key=value pairs for set")
    .action(async (action: string, kv: string[]) => {
      if (action === "get") {
        const res = await esimFetch(parentOpts(), "/defaults");
        console.log(JSON.stringify(await res.json(), null, 2));
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
        const res = await esimFetch(parentOpts(), "/defaults", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(obj),
        });
        console.log(JSON.stringify(await res.json(), null, 2));
      } else {
        console.error("Usage: otacon phone esim defaults [get|set <k=v>]");
        process.exit(1);
      }
    });

  return esim;
}
