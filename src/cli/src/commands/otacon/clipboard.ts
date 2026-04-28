import type { CommandSpec } from "./types.js";

export const clipboard: CommandSpec = {
  name: "clipboard",
  description: "Get or set the device clipboard.",
  usage: "otacon clipboard [get | set <text>]",
  examples: ["otacon clipboard get", 'otacon clipboard set "hi"'],
  isMutating: true,
  async run(args, client) {
    const sub = args[0] ?? "get";
    if (sub === "get") {
      const r = await client.clipboardGet();
      return r.text ?? "(empty)";
    }
    if (sub === "set") {
      const text = args.slice(1).join(" ");
      await client.clipboardSet(text);
      return "clipboard set";
    }
    throw new Error("usage: otacon clipboard <get|set>");
  },
};
