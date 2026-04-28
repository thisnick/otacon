import type { CommandSpec } from "./types.js";

export const sms: CommandSpec = {
  name: "sms",
  description: "SMS: list threads, read messages in a thread, send a message.",
  usage: "otacon sms [list | read <thread_id> | send <to> <body>]",
  examples: [
    "otacon sms list",
    "otacon sms read 12",
    'otacon sms send +12135551212 "hello"',
  ],
  isMutating: true,
  async run(args, client) {
    const sub = args[0] ?? "list";
    if (sub === "list") {
      const threads = await client.smsThreads();
      return JSON.stringify(threads, null, 2);
    }
    if (sub === "read" || sub === "messages") {
      const id = parseInt(args[1]);
      if (isNaN(id)) throw new Error("usage: otacon sms read <thread_id>");
      const msgs = await client.smsMessages(id);
      return JSON.stringify(msgs, null, 2);
    }
    if (sub === "send") {
      const to = args[1];
      const body = args.slice(2).join(" ");
      if (!to || !body) throw new Error("usage: otacon sms send <to> <body>");
      await client.smsSend(to, body);
      return `sent SMS to ${to}`;
    }
    throw new Error(`unknown sms subcommand: ${sub}`);
  },
};
