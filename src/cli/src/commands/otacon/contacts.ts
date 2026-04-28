import type { CommandSpec } from "./types.js";

export const contacts: CommandSpec = {
  name: "contacts",
  description: "Search contacts by name or number (omit query for full list).",
  usage: "otacon contacts [query]",
  examples: ["otacon contacts", "otacon contacts alex"],
  isMutating: false,
  async run(args, client) {
    const query = args.length > 0 ? args.join(" ") : undefined;
    const list = await client.contacts(query);
    return JSON.stringify(list, null, 2);
  },
};
