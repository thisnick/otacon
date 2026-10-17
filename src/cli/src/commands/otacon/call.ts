import type { CommandSpec } from "./types.js";
import type { Call, CallCommandResponse } from "../../client.js";
import { captureAnnotated } from "./_trace.js";

const USAGE =
  "otacon call <status | dial <number> | answer [--call <id>] | reject [--call <id>] | " +
  "hangup [--call <id>] | hold | resume | swap | merge | dtmf <digits>>";

const MUTATING_SUBS = new Set([
  "dial", "answer", "reject", "hangup", "hold", "resume", "swap", "merge", "dtmf",
]);

/** Plain-text call table (no ANSI: this output also goes to sandboxed agents). */
export function formatCalls(calls: Call[]): string {
  if (calls.length === 0) return "(no calls)";
  const header = ["ID", "NUMBER", "DIRECTION", "STATE", "CONFERENCE"];
  const rows = calls.map((c) => [
    c.id,
    c.number ?? "-",
    c.direction,
    c.state,
    c.conference ? "yes" : "no",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  return [header, ...rows]
    .map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd())
    .join("\n");
}

function describeCall(c: Call | null | undefined): string {
  if (!c) return "";
  return ` ${c.id}${c.number ? ` (${c.number})` : ""}`;
}

function fallbackNote(r: CallCommandResponse): string {
  return r.fallback ? ` [via ${r.fallback} fallback: Bluetooth control link is down]` : "";
}

/** Parse `--call <id>` out of args[1..]. */
function callFlag(args: string[]): string | undefined {
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--call") {
      const id = args[i + 1];
      if (!id) throw new Error("--call needs a call id (see `otacon call status`)");
      return id;
    }
    if (args[i].startsWith("--call=")) return args[i].slice("--call=".length);
  }
  return undefined;
}

export const call: CommandSpec = {
  name: "call",
  description:
    "Voice calls: list calls, dial, answer, reject, hang up, hold/resume/swap/merge, send DTMF.",
  usage: USAGE,
  examples: [
    "otacon call status",
    "otacon call dial +15550001111",
    "otacon call answer",
    "otacon call hangup --call call_7f3a9c",
    "otacon call hold",
    "otacon call merge",
    "otacon call dtmf '1234#'",
  ],
  isMutating: true,
  async run(args, client, env) {
    const sub = args[0];
    if (sub && MUTATING_SUBS.has(sub) && env.OTACON_TRACE_DIR) {
      await captureAnnotated(env.OTACON_TRACE_DIR, { verb: "call", args }, client);
    }
    switch (sub) {
      case "status":
      case undefined: {
        const st = await client.callStatus();
        return JSON.stringify(st, null, 2);
      }
      case "dial": {
        const to = args[1];
        if (!to) throw new Error("usage: otacon call dial <number>");
        const r = await client.callDial(to);
        return `dialing ${to}${r.call ? ` (call ${r.call.id})` : ""}${fallbackNote(r)}`;
      }
      case "answer": {
        const r = await client.callAnswer(callFlag(args));
        return `answered${describeCall(r.call)}${fallbackNote(r)}`;
      }
      case "reject": {
        const r = await client.callReject(callFlag(args));
        return `rejected${describeCall(r.call)}${fallbackNote(r)}`;
      }
      case "hangup": {
        const r = await client.callHangup(callFlag(args));
        return `hung up${describeCall(r.call)}${fallbackNote(r)}`;
      }
      case "hold":
      case "resume":
      case "swap":
      case "merge": {
        const r =
          sub === "hold" ? await client.callHold()
          : sub === "resume" ? await client.callResume()
          : sub === "swap" ? await client.callSwap()
          : await client.callMerge();
        const done = { hold: "on hold", resume: "resumed", swap: "swapped", merge: "merged" }[sub];
        return r.calls ? `${done}\n${formatCalls(r.calls)}` : done;
      }
      case "dtmf": {
        const digits = args[1];
        if (!digits) throw new Error("usage: otacon call dtmf <digits>  (0-9 * # A-D; w = 500 ms pause)");
        const r = await client.callDtmf(digits);
        return `sent DTMF ${r.digits ?? digits}`;
      }
    }
    throw new Error(`usage: ${USAGE}`);
  },
};
