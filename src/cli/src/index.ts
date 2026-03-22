#!/usr/bin/env node
import { program } from "commander";
import { writeFileSync } from "fs";
import { OtaconClient } from "./client.js";

const DEFAULT_HOST = "https://otacon-pi:8080";

function getClient(opts: { host?: string }): OtaconClient {
  const baseUrl =
    opts.host || process.env.OTACON_HOST || DEFAULT_HOST;
  return new OtaconClient(baseUrl);
}

program
  .name("otacon")
  .description("CLI for otacon phone automation")
  .option("--host <url>", "server URL (or OTACON_HOST env var)");

// --- UI Actions ---

program
  .command("tap")
  .description("Tap at coordinates or element ref")
  .argument("<target...>", 'coordinates "x y" or ref "e5"')
  .action(async (target: string[]) => {
    const client = getClient(program.opts());
    if (target.length === 1 && target[0].match(/^e\d+$/)) {
      await client.action({ action: "tap", ref: target[0] });
    } else if (target.length === 2) {
      await client.action({
        action: "tap",
        x: parseInt(target[0]),
        y: parseInt(target[1]),
      });
    } else {
      console.error('Usage: otacon tap <x> <y> | otacon tap <ref>');
      process.exit(1);
    }
  });

program
  .command("long-tap")
  .description("Long-tap at coordinates or element ref")
  .argument("<target...>", 'coordinates "x y" or ref "e5"')
  .action(async (target: string[]) => {
    const client = getClient(program.opts());
    if (target.length === 1 && target[0].match(/^e\d+$/)) {
      await client.action({ action: "long_tap", ref: target[0] });
    } else if (target.length === 2) {
      await client.action({
        action: "long_tap",
        x: parseInt(target[0]),
        y: parseInt(target[1]),
      });
    } else {
      console.error('Usage: otacon long-tap <x> <y> | otacon long-tap <ref>');
      process.exit(1);
    }
  });

program
  .command("swipe")
  .description("Swipe gesture")
  .argument("<x1>", "start x")
  .argument("<y1>", "start y")
  .argument("<x2>", "end x")
  .argument("<y2>", "end y")
  .option("-d, --duration <ms>", "duration in ms", "300")
  .action(async (x1: string, y1: string, x2: string, y2: string, opts: { duration: string }) => {
    const client = getClient(program.opts());
    await client.action({
      action: "swipe",
      x1: parseInt(x1),
      y1: parseInt(y1),
      x2: parseInt(x2),
      y2: parseInt(y2),
      duration_ms: parseInt(opts.duration),
    });
  });

program
  .command("key")
  .description("Press a key (home, back, enter, etc.)")
  .argument("<name>", "key name or keycode")
  .action(async (name: string) => {
    const client = getClient(program.opts());
    await client.action({ action: "key", key: name });
  });

program
  .command("type")
  .description("Type text")
  .argument("<text>", "text to type")
  .action(async (text: string) => {
    const client = getClient(program.opts());
    await client.action({ action: "type", text });
  });

// --- Screen ---

program
  .command("screenshot")
  .description("Take a screenshot")
  .option("-o, --output <path>", "output file path")
  .action(async (opts: { output?: string }) => {
    const client = getClient(program.opts());
    const png = await client.screenshot();
    if (opts.output) {
      writeFileSync(opts.output, png);
      console.error(`Saved to ${opts.output}`);
    } else {
      process.stdout.write(png);
    }
  });

program
  .command("snapshot")
  .description("Get accessibility tree")
  .option("--json", "output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const client = getClient(program.opts());
    const result = await client.snapshot(opts.json ? "json" : "text");
    if (typeof result === "string") {
      console.log(result);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  });

// --- SMS ---

const sms = program.command("sms").description("SMS commands");

sms
  .command("list")
  .description("List SMS threads")
  .action(async () => {
    const client = getClient(program.opts());
    const threads = await client.smsThreads();
    console.log(JSON.stringify(threads, null, 2));
  });

sms
  .command("read")
  .description("Read messages in a thread")
  .argument("<thread_id>", "thread ID")
  .action(async (threadId: string) => {
    const client = getClient(program.opts());
    const messages = await client.smsMessages(parseInt(threadId));
    console.log(JSON.stringify(messages, null, 2));
  });

sms
  .command("send")
  .description("Send an SMS")
  .argument("<to>", "phone number")
  .argument("<body>", "message body")
  .action(async (to: string, body: string) => {
    const client = getClient(program.opts());
    await client.smsSend(to, body);
  });

// --- Notifications ---

const notifications = program
  .command("notifications")
  .description("Notification commands");

notifications
  .command("list")
  .description("List current notifications")
  .action(async () => {
    const client = getClient(program.opts());
    const notifs = await client.notifications();
    console.log(JSON.stringify(notifs, null, 2));
  });

// --- Apps ---

const apps = program.command("apps").description("App commands");

apps
  .command("list")
  .description("List installed apps")
  .action(async () => {
    const client = getClient(program.opts());
    const list = await client.apps();
    console.log(JSON.stringify(list, null, 2));
  });

apps
  .command("running")
  .description("List running/foreground apps")
  .action(async () => {
    const client = getClient(program.opts());
    const list = await client.appsRunning();
    console.log(JSON.stringify(list, null, 2));
  });

apps
  .command("launch")
  .description("Launch an app")
  .argument("<package>", "package name")
  .action(async (pkg: string) => {
    const client = getClient(program.opts());
    await client.appLaunch(pkg);
  });

apps
  .command("stop")
  .description("Force stop an app")
  .argument("<package>", "package name")
  .action(async (pkg: string) => {
    const client = getClient(program.opts());
    await client.appStop(pkg);
  });

// --- Contacts ---

const contacts = program
  .command("contacts")
  .description("Contact commands");

contacts
  .command("search")
  .description("Search contacts")
  .argument("<query>", "search query")
  .action(async (query: string) => {
    const client = getClient(program.opts());
    const list = await client.contacts(query);
    console.log(JSON.stringify(list, null, 2));
  });

// --- Device ---

program
  .command("info")
  .description("Device and activity info")
  .action(async () => {
    const client = getClient(program.opts());
    const info = await client.info();
    console.log(JSON.stringify(info, null, 2));
  });

// --- Run ---

program.parseAsync().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
