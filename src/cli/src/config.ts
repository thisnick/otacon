import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse, stringify } from "@iarna/toml";

export interface OtaconConfig {
  registry_url?: string;
  token?: string;
  active_phone?: string;
}

function configDir(): string {
  return process.env.OTACON_CONFIG_DIR || join(homedir(), ".otacon");
}

function configPath(): string {
  return join(configDir(), "config.toml");
}

/** Read config from TOML file. Returns empty object if file doesn't exist. */
export function loadConfig(): OtaconConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = parse(raw);
    return {
      registry_url: parsed.registry_url as string | undefined,
      token: parsed.token as string | undefined,
      active_phone: parsed.active_phone as string | undefined,
    };
  } catch {
    return {};
  }
}

/** Write config to TOML file (chmod 0600). */
export function saveConfig(config: OtaconConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = configPath();
  const obj: Record<string, string> = {};
  if (config.registry_url) obj.registry_url = config.registry_url;
  if (config.token) obj.token = config.token;
  if (config.active_phone) obj.active_phone = config.active_phone;
  writeFileSync(path, stringify(obj as any), { mode: 0o600 });
  // Ensure permissions even if file already existed
  chmodSync(path, 0o600);
}

/**
 * Resolve a config value with precedence: env var > CLI flag > config file.
 */
export function resolveConfig(flags: {
  registry?: string;
  phone?: string;
}): { registryUrl?: string; token?: string; activePhone?: string } {
  const config = loadConfig();

  const registryUrl =
    process.env.OTACON_REGISTRY_URL ||
    flags.registry ||
    config.registry_url;

  const token =
    process.env.OTACON_TOKEN ||
    config.token;

  const activePhone =
    process.env.OTACON_PHONE ||
    flags.phone ||
    config.active_phone;

  return { registryUrl, token, activePhone };
}
