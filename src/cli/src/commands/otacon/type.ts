import type { CommandSpec } from "./types.js";
import { captureAnnotated } from "./_trace.js";

export const typeCmd: CommandSpec = {
  name: "type",
  description: "Type text via ADB input (ASCII only — use set-text for Unicode).",
  usage: "otacon type <text>",
  examples: ['otacon type "hello world"'],
  isMutating: true,
  async run(args, client, env) {
    const text = args.join(" ");
    if (!text) throw new Error(`usage: ${this.usage}`);

    if (env.OTACON_TRACE_DIR) {
      await captureAnnotated(env.OTACON_TRACE_DIR, {
        verb: "type",
        args,
        annotation: { type: "text", label: `type: ${text.slice(0, 60)}` },
      }, client);
    }

    await client.action({ action: "type", text } as any);
    return `typed "${text}"`;
  },
};
