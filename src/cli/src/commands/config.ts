import { Command } from "commander";
import { resolveConfig } from "../config.js";
import { RegistryClient, type PhoneConfig } from "../registry-client.js";
import { printDetail } from "../format.js";

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
    console.error("No phone specified. Pass --phone or run `otacon phones use <id>`");
    process.exit(1);
  }
  return resolved.activePhone;
}

function parseBool(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled", "enable"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled", "disable"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value '${value}' (use on/off or true/false)`);
}

function applyConfigPairs(current: PhoneConfig, pairs: string[]): PhoneConfig {
  const next = { ...current };
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx <= 0) {
      throw new Error(`Invalid config '${pair}' (expected key=value)`);
    }
    const key = pair.slice(0, idx).trim().toLowerCase().replaceAll("-", "_");
    const value = pair.slice(idx + 1).trim();
    if (key === "bt" || key === "bluetooth" || key === "bluetooth_enabled") {
      next.bluetooth_enabled = parseBool(value);
    } else {
      throw new Error(`Unsupported registry config key '${key}' (use bluetooth_enabled)`);
    }
  }
  return next;
}

export function configCommands(parentOpts: () => ParentOpts): Command {
  const config = new Command("config").description("Registry phone config");

  config
    .command("get")
    .description("Show registry config for a phone")
    .argument("[phone-id]", "phone ID (defaults to active phone)")
    .option("--json", "output as JSON")
    .action(async (phoneIdArg: string | undefined, opts: { json?: boolean }) => {
      const phoneId = resolvePhoneId(parentOpts, phoneIdArg);
      const client = getRegistryClient(parentOpts());
      const config = await client.getPhoneConfig(phoneId);
      printDetail(config as unknown as Record<string, unknown>, { json: opts.json });
    });

  config
    .command("set")
    .description("Set registry config for the active phone")
    .argument("<kv...>", "key=value pairs, e.g. bluetooth_enabled=off")
    .option("--json", "output as JSON")
    .action(async (kv: string[], opts: { json?: boolean }) => {
      const phoneId = resolvePhoneId(parentOpts);
      const client = getRegistryClient(parentOpts());
      const current = await client.getPhoneConfig(phoneId);
      const next = applyConfigPairs(current, kv);
      const result = await client.setPhoneConfig(phoneId, next);
      printDetail({
        ...next,
        pushed: result.pushed,
      }, { json: opts.json });
    });

  return config;
}
