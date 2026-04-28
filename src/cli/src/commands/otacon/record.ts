import * as fs from "node:fs";
import type { CommandSpec } from "./types.js";
import { captureAnnotated } from "./_trace.js";

export const record: CommandSpec = {
  name: "record",
  description: "Screen recording: start, stop (saves MP4), or check status.",
  usage: "otacon record <start [-d secs] | stop [-o path] | status>",
  examples: ["otacon record start -d 60", "otacon record stop -o /tmp/clip.mp4", "otacon record status"],
  isMutating: true,
  async run(args, client, env) {
    const sub = args[0];
    if ((sub === "start" || sub === "stop") && env.OTACON_TRACE_DIR) {
      await captureAnnotated(env.OTACON_TRACE_DIR, { verb: "record", args }, client);
    }
    if (sub === "start") {
      let duration = 30;
      for (let i = 1; i < args.length; i++) {
        if ((args[i] === "-d" || args[i] === "--duration") && args[i + 1]) duration = parseInt(args[++i]);
      }
      await client.recordStart(duration);
      return `recording started (max ${duration}s)`;
    }
    if (sub === "stop") {
      let outPath: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if ((args[i] === "-o" || args[i] === "--output") && args[i + 1]) outPath = args[++i];
      }
      const buf = await client.recordStop();
      if (outPath) {
        fs.writeFileSync(outPath, buf);
        return `Saved to ${outPath}`;
      }
      return `[recording stopped: ${buf.length} bytes]`;
    }
    if (sub === "status") {
      const st = await client.recordStatus();
      return JSON.stringify(st, null, 2);
    }
    throw new Error("usage: otacon record <start|stop|status>");
  },
};
