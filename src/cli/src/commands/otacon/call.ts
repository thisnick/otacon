import type { CommandSpec } from "./types.js";
import { captureAnnotated } from "./_trace.js";

export const call: CommandSpec = {
  name: "call",
  description: "Voice call: dial, answer, hang up, or check status.",
  usage: "otacon call <dial <number> | answer | hangup | status>",
  examples: ["otacon call dial +12135551212", "otacon call answer", "otacon call hangup", "otacon call status"],
  isMutating: true,
  async run(args, client, env) {
    const sub = args[0];
    const isMutatingSub = sub === "dial" || sub === "answer" || sub === "hangup";
    if (isMutatingSub && env.OTACON_TRACE_DIR) {
      await captureAnnotated(env.OTACON_TRACE_DIR, { verb: "call", args }, client);
    }
    if (sub === "dial") {
      const num = args[1];
      if (!num) throw new Error("usage: otacon call dial <number>");
      await client.callDial(num);
      return `dialing ${num}`;
    }
    if (sub === "answer") {
      await client.callAnswer();
      return "answered call";
    }
    if (sub === "hangup") {
      await client.callHangup();
      return "hung up";
    }
    if (sub === "status") {
      const st = await client.callStatus();
      return JSON.stringify(st, null, 2);
    }
    throw new Error("usage: otacon call <dial|answer|hangup|status>");
  },
};
