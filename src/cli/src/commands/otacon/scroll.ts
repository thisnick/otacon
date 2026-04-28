import type { CommandSpec } from "./types.js";
import { captureAnnotated } from "./_trace.js";

export const scroll: CommandSpec = {
  name: "scroll",
  description: "Scroll a scrollable element. Default direction is forward (down).",
  usage: "otacon scroll <ref> [--direction up|down]",
  examples: ["otacon scroll e3", "otacon scroll e3 --direction up"],
  isMutating: true,
  async run(args, client, env) {
    let ref: string | undefined;
    let direction = "down";
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--direction" && args[i + 1]) direction = args[++i];
      else if (args[i] === "--up") direction = "up";
      else if (!ref) ref = args[i];
    }
    if (!ref) throw new Error(`usage: ${this.usage}`);

    if (env.OTACON_TRACE_DIR) {
      await captureAnnotated(env.OTACON_TRACE_DIR, {
        verb: "scroll",
        args,
        annotation: { type: "text", label: `scroll ${ref} ${direction}` },
      }, client);
    }

    const action = direction === "up" ? "scroll_backward" : "scroll_forward";
    await client.action({ action, ref } as any);
    return `scrolled ${ref} ${direction}`;
  },
};
