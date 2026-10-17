import { Command } from "commander";
import { loadConfig, saveConfig, type OtaconLink } from "../config.js";

/** Split `https://host:8080/phones/<id>` into host and phone, if given that way. */
function parseTarget(host: string, phone?: string): { host: string; phone?: string } {
  const m = host.match(/^(https?:\/\/[^/]+)\/phones\/([^/?#]+)\/?$/);
  if (m && !phone) return { host: m[1], phone: decodeURIComponent(m[2]) };
  return { host: host.replace(/\/+$/, ""), phone };
}

function describe(link: OtaconLink): string {
  return `linked to phone ${link.phone} on ${link.host}`;
}

export function linkCommands(): Command[] {
  const link = new Command("link")
    .description("Link this CLI straight to one phone on an otacon host (no registry), or show the link")
    .argument("[host]", "host base URL, e.g. https://otacon-pi.<tailnet>.ts.net:8080 (or the phone's URL .../phones/<id>)")
    .argument("[phone]", "the host's id for the phone, e.g. phone-r5ct60sd")
    .addHelpText(
      "after",
      `
Once linked, phone commands (screenshot, tap, sms, call, ...) go to that phone
without the registry; --phone / OTACON_PHONE pick another phone on the same
host. --host / OTACON_HOST still override the link. Saved in
~/.otacon/config.toml; \`otacon unlink\` removes it.

Examples:
  otacon link https://otacon-pi.example.ts.net:8080 phone-r5ct60sd
  otacon link            # show the current link`,
    )
    .action(async (hostArg?: string, phoneArg?: string) => {
      const config = loadConfig();
      if (!hostArg) {
        if (!config.link) {
          console.error("Not linked. Run `otacon link <host> <phone>`.");
          process.exit(1);
        }
        console.log(JSON.stringify(config.link, null, 2));
        return;
      }
      const { host, phone } = parseTarget(hostArg, phoneArg);
      if (!phone) {
        console.error("Which phone? `otacon link <host> <phone>` (the host's id, e.g. phone-r5ct60sd)");
        process.exit(1);
      }
      // Check the phone exists on that host before saving.
      let res: Response;
      try {
        res = await fetch(`${host}/phones/${encodeURIComponent(phone)}`);
      } catch (err) {
        console.error(`Can't reach ${host}: ${(err as Error).message}`);
        process.exit(1);
      }
      if (res.status === 404) {
        console.error(`${host} has no phone ${phone}. Its phones: ${host}/phones`);
        process.exit(1);
      }
      if (!res.ok) {
        console.error(`${host} answered HTTP ${res.status}`);
        process.exit(1);
      }
      const info = (await res.json().catch(() => ({}))) as { adb_serial?: string };
      config.link = { mode: "phone", host, phone };
      saveConfig(config);
      console.error(`${describe(config.link)}${info.adb_serial ? ` (serial ${info.adb_serial})` : ""}`);
    });

  const unlink = new Command("unlink").description("Remove the phone link (`otacon link`)").action(() => {
    const config = loadConfig();
    if (!config.link) {
      console.error("Not linked.");
      return;
    }
    const was = describe(config.link);
    delete config.link;
    saveConfig(config);
    console.error(`Removed: ${was}`);
  });

  return [link, unlink];
}
