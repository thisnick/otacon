import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CommandSpec } from "./types.js";

export const snapshot: CommandSpec = {
  name: "snapshot",
  description: "Get the accessibility tree of the current screen (text or JSON).",
  usage: "otacon snapshot [--json]",
  examples: ["otacon snapshot", "otacon snapshot --json"],
  isMutating: false,
  async run(args, client, env) {
    const json = args.includes("--json");
    const out = json
      ? JSON.stringify(await client.snapshot("json"), null, 2)
      : await client.snapshot("text");

    if (env.OTACON_TRACE_DIR) {
      await fs.mkdir(env.OTACON_TRACE_DIR, { recursive: true });
      const seq = await nextSeq(env.OTACON_TRACE_DIR);
      const seqStr = String(seq).padStart(3, "0");
      await fs.writeFile(
        path.join(env.OTACON_TRACE_DIR, `${seqStr}-snapshot.json`),
        JSON.stringify({ seq, verb: "snapshot", args, ts: new Date().toISOString(), output: out }, null, 2),
      );
    }
    return out;
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
