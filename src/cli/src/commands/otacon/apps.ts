import * as fs from "node:fs";
import type { CommandSpec } from "./types.js";

export const apps: CommandSpec = {
  name: "apps",
  description:
    "App control: list installed apps, list running apps, launch, stop, install. Subcommand defaults to `list`.",
  usage: "otacon apps [list | running | launch <pkg> | stop <pkg> | install <apk>]",
  examples: [
    "otacon apps",
    "otacon apps running",
    "otacon apps launch com.xingin.xhs",
    "otacon apps stop com.xingin.xhs",
  ],
  isMutating: true, // launch/stop/install mutate; list/running don't but conservative
  async run(args, client) {
    const sub = args[0] ?? "list";
    if (sub === "list") {
      const list = await client.apps();
      return list.map(a => `${a.package} (${a.label || "no label"})`).join("\n");
    }
    if (sub === "running") {
      const result = await client.appsRunning();
      return JSON.stringify(result, null, 2);
    }
    if (sub === "launch") {
      const pkg = args[1];
      if (!pkg) throw new Error("usage: otacon apps launch <package>");
      await client.appLaunch(pkg);
      return `launched ${pkg}`;
    }
    if (sub === "stop") {
      const pkg = args[1];
      if (!pkg) throw new Error("usage: otacon apps stop <package>");
      await client.appStop(pkg);
      return `stopped ${pkg}`;
    }
    if (sub === "install") {
      const apk = args[1];
      if (!apk) throw new Error("usage: otacon apps install <apk>");
      const data = fs.readFileSync(apk);
      await client.appInstall(data);
      return `installed ${apk}`;
    }
    throw new Error(`unknown apps subcommand: ${sub}`);
  },
};
