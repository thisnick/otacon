import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CommandSpec } from "./types.js";

export const screenshot: CommandSpec = {
  name: "screenshot",
  description: "Capture the current screen as a PNG.",
  usage: "otacon screenshot [-o|--output path]",
  examples: ["otacon screenshot", "otacon screenshot -o /tmp/now.png"],
  isMutating: false,
  async run(args, client, env) {
    let outPath: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === "-o" || args[i] === "--output") && args[i + 1]) outPath = args[++i];
    }

    const png = await client.screenshot();

    if (env.OTACON_TRACE_DIR) {
      // Save raw screenshot to trace dir (no annotation needed)
      await fs.mkdir(env.OTACON_TRACE_DIR, { recursive: true });
      const seq = await nextSeq(env.OTACON_TRACE_DIR);
      const seqStr = String(seq).padStart(3, "0");
      await fs.writeFile(path.join(env.OTACON_TRACE_DIR, `${seqStr}-screenshot.png`), png);
      await fs.writeFile(
        path.join(env.OTACON_TRACE_DIR, `${seqStr}-screenshot.json`),
        JSON.stringify({ seq, verb: "screenshot", args, ts: new Date().toISOString() }, null, 2),
      );
    }

    if (outPath) {
      await fs.writeFile(outPath, png);
      return `Saved to ${outPath}`;
    }
    return `[screenshot captured: ${png.length} bytes]`;
  },
};

async function nextSeq(dir: string): Promise<number> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const name of entries) {
    const m = name.match(/^(\d{3})-/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}
