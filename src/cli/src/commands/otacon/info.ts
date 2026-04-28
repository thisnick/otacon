import type { CommandSpec } from "./types.js";

export const info: CommandSpec = {
  name: "info",
  description: "Device and activity info (resolution, screen state, current app, battery, etc.).",
  usage: "otacon info [--json]",
  examples: ["otacon info", "otacon info --json"],
  isMutating: false,
  async run(args, client) {
    const data = await client.info() as Record<string, unknown>;
    if (args.includes("--json")) return JSON.stringify(data, null, 2);
    if ("monitor" in data && !args.includes("--monitor")) delete data.monitor;
    return Object.entries(data)
      .filter(([, v]) => typeof v !== "object" || v === null)
      .map(([k, v]) => `${k.padEnd(20)} ${v ?? "-"}`)
      .join("\n");
  },
};
