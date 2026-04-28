import type { CommandSpec } from "./types.js";
import { captureAnnotated } from "./_trace.js";

export const swipe: CommandSpec = {
  name: "swipe",
  description: "Swipe gesture from (x1,y1) to (x2,y2). Default duration 300ms.",
  usage: "otacon swipe <x1> <y1> <x2> <y2> [--duration ms] [--pause ms]",
  examples: [
    "otacon swipe 540 1800 540 600",
    "otacon swipe 540 1200 540 800 --duration 400",
  ],
  isMutating: true,
  async run(args, client, env) {
    if (args.length < 4) throw new Error(`usage: ${this.usage}`);
    const x1 = parseInt(args[0]);
    const y1 = parseInt(args[1]);
    const x2 = parseInt(args[2]);
    const y2 = parseInt(args[3]);
    if ([x1, y1, x2, y2].some(isNaN)) throw new Error(`usage: ${this.usage}`);

    let duration = 300;
    let pause = 0;
    for (let i = 4; i < args.length; i++) {
      if (args[i] === "--duration" && args[i + 1]) duration = parseInt(args[++i]);
      else if (args[i] === "--pause" && args[i + 1]) pause = parseInt(args[++i]);
    }

    if (env.OTACON_TRACE_DIR) {
      await captureAnnotated(env.OTACON_TRACE_DIR, {
        verb: "swipe",
        args,
        annotation: { type: "swipe", startX: x1, startY: y1, endX: x2, endY: y2 },
      }, client);
    }

    await client.action({
      action: "swipe",
      x1, y1, x2, y2,
      duration_ms: duration,
      pause_ms: pause,
    } as any);
    return `swiped ${args.join(" ")}`;
  },
};
