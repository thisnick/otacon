import type { CommandSpec } from "./types.js";
import { captureAnnotated } from "./_trace.js";

export const setText: CommandSpec = {
  name: "set-text",
  description: "Set text on a focused element (supports Unicode).",
  usage: "otacon set-text <ref> <text>",
  examples: ['otacon set-text e5 "ni hao"'],
  isMutating: true,
  async run(args, client, env) {
    const [ref, ...rest] = args;
    if (!ref || rest.length === 0) throw new Error(`usage: ${this.usage}`);
    const text = rest.join(" ");

    if (env.OTACON_TRACE_DIR) {
      await captureAnnotated(env.OTACON_TRACE_DIR, {
        verb: "set-text",
        args,
        annotation: { type: "text", label: `set-text ${ref}: ${text.slice(0, 50)}` },
      }, client);
    }

    await client.action({ action: "set_text", ref, text } as any);
    return `set text on ${ref}: "${text}"`;
  },
};
