import type { CommandSpec } from "./types.js";
import { captureAnnotated } from "./_trace.js";

export const clipboard: CommandSpec = {
  name: "clipboard",
  description: "Get or set the device clipboard.",
  usage: "otacon clipboard [get | set <text>]",
  examples: ["otacon clipboard get", 'otacon clipboard set "hi"'],
  isMutating: true,
  async run(args, client, env) {
    const sub = args[0] ?? "get";
    if (sub === "get") {
      const r = await client.clipboardGet();
      return r.text ?? "(empty)";
    }
    if (sub === "set") {
      if (env.OTACON_TRACE_DIR) {
        await captureAnnotated(env.OTACON_TRACE_DIR, { verb: "clipboard", args }, client);
      }
      const text = args.slice(1).join(" ");
      await client.clipboardSet(text);
      return "clipboard set";
    }
    throw new Error("usage: otacon clipboard <get|set>");
  },
};
