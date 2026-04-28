import type { CommandSpec } from "./types.js";
import { captureAnnotated } from "./_trace.js";

export const open: CommandSpec = {
  name: "open",
  description: "Open a URI with the registered app (https://, tel:, app deep links, etc.).",
  usage: "otacon open <uri>",
  examples: ["otacon open https://example.com", "otacon open tel:+12135551212"],
  isMutating: true,
  async run(args, client, env) {
    const uri = args[0];
    if (!uri) throw new Error(`usage: ${this.usage}`);

    if (env.OTACON_TRACE_DIR) {
      await captureAnnotated(env.OTACON_TRACE_DIR, {
        verb: "open",
        args,
        annotation: { type: "text", label: `open ${uri}` },
      }, client);
    }

    await client.open(uri);
    return `opened ${uri}`;
  },
};
