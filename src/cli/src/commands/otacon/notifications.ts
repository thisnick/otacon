import type { CommandSpec } from "./types.js";
import { captureAnnotated } from "./_trace.js";

export const notifications: CommandSpec = {
  name: "notifications",
  description: "List notifications, dismiss one, or trigger an action button.",
  usage: "otacon notifications [list | dismiss <key> | action <key> <index>]",
  examples: [
    "otacon notifications",
    "otacon notifications dismiss 0|com.example|123|null",
    "otacon notifications action 0|com.example|123|null 0",
  ],
  isMutating: true,
  async run(args, client, env) {
    const sub = args[0] ?? "list";
    if (sub === "list") {
      const notifs = await client.notifications();
      return JSON.stringify(notifs, null, 2);
    }
    if ((sub === "dismiss" || sub === "action") && env.OTACON_TRACE_DIR) {
      await captureAnnotated(env.OTACON_TRACE_DIR, { verb: "notifications", args }, client);
    }
    if (sub === "dismiss") {
      const key = args[1];
      if (!key) throw new Error("usage: otacon notifications dismiss <key>");
      await client.notificationDismiss(key);
      return `dismissed ${key}`;
    }
    if (sub === "action") {
      const key = args[1];
      const idx = parseInt(args[2]);
      if (!key || isNaN(idx)) throw new Error("usage: otacon notifications action <key> <index>");
      await client.notificationAction(key, idx);
      return `triggered action ${idx} on ${key}`;
    }
    throw new Error("usage: otacon notifications <list|dismiss|action>");
  },
};
