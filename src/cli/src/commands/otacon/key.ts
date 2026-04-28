import type { CommandSpec } from "./types.js";
import { captureAnnotated } from "./_trace.js";

export const key: CommandSpec = {
  name: "key",
  description: "Press a hardware/system key (BACK, HOME, ENTER, etc.) or keycode.",
  usage: "otacon key <name>",
  examples: ["otacon key BACK", "otacon key HOME", "otacon key ENTER"],
  isMutating: true,
  async run(args, client, env) {
    const k = args[0];
    if (!k) throw new Error(`usage: ${this.usage}`);

    if (env.OTACON_TRACE_DIR) {
      await captureAnnotated(env.OTACON_TRACE_DIR, {
        verb: "key",
        args,
        annotation: { type: "text", label: `key: ${k}` },
      }, client);
    }

    await client.action({ action: "key", key: k } as any);
    return `sent key ${k}`;
  },
};
