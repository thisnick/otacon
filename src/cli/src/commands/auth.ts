import { Command } from "commander";
import { resolveConfig } from "../config.js";
import { registerClient, saveAuth, removeAuth, whoami } from "../auth.js";

export function authCommands(): Command {
  const auth = new Command("auth").description("Authentication commands");

  auth
    .command("register")
    .description("Register with a registry (long-polls for admin approval)")
    .option("--registry <url>", "registry URL")
    .action(async (opts: { registry?: string }) => {
      const { registryUrl } = resolveConfig({ registry: opts.registry });
      if (!registryUrl) {
        console.error(
          "No registry URL. Set OTACON_REGISTRY_URL, pass --registry, or add registry_url to ~/.otacon/config.toml"
        );
        process.exit(1);
      }

      try {
        const token = await registerClient(registryUrl);
        saveAuth(registryUrl, token);
        console.error("Registered successfully. Token saved to ~/.otacon/config.toml");
      } catch (err) {
        console.error(`Registration failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  auth
    .command("unregister")
    .description("Remove saved token from config")
    .action(() => {
      removeAuth();
      console.error("Token removed from config");
    });

  auth
    .command("whoami")
    .description("Show registry URL, token fingerprint, and active phone")
    .action(() => {
      const info = whoami();
      if (!info.registryUrl && !info.tokenPrefix) {
        console.error("Not registered. Run `otacon auth register` first.");
        process.exit(1);
      }
      console.log(
        JSON.stringify(
          {
            registry_url: info.registryUrl ?? null,
            token: info.tokenPrefix ?? null,
            active_phone: info.activePhone ?? null,
          },
          null,
          2
        )
      );
    });

  return auth;
}
