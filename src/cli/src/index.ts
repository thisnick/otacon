#!/usr/bin/env node
// Accept Tailscale self-signed certs (set before any imports to avoid warning)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { program } from "commander";
import { readFileSync, writeFileSync } from "fs";
import type { Action } from "./client.js";
import { getHostClient } from "./host-client.js";
import { authCommands } from "./commands/auth.js";
import { regCommands } from "./commands/reg.js";
import { phoneCommands } from "./commands/phone.js";
import { phoneEsimCommands } from "./commands/phone-esim.js";
import { hostCommands } from "./commands/host.js";
import { dongleCommands } from "./commands/dongle.js";
import { printList } from "./format.js";
import { clientCommands } from "./commands/client.js";

program
  .name("otacon")
  .description("CLI for otacon phone automation")
  .option("--host <url>", "server URL (or OTACON_HOST env var)")
  .option("--phone <id>", "phone ID (or OTACON_PHONE env var)")
  .option("--registry <url>", "registry URL (or OTACON_REGISTRY_URL env var)");

// Helper to get the client (resolves via registry, direct host, or Tailscale)
async function getClient(): Promise<import("./client.js").OtaconClient> {
  const opts = program.opts() as { host?: string; phone?: string; registry?: string };
  return getHostClient(opts);
}

// ── Subcommand groups ─────────────────────────────────────────────

const getParentOpts = () => program.opts() as { host?: string; phone?: string; registry?: string };

program.addCommand(authCommands());
program.addCommand(regCommands(getParentOpts));
program.addCommand(hostCommands(getParentOpts));
program.addCommand(dongleCommands(getParentOpts));
program.addCommand(clientCommands(getParentOpts));

const phone = phoneCommands(getParentOpts);
phone.addCommand(phoneEsimCommands(getParentOpts));
program.addCommand(phone);

// ── Top-level per-phone commands (daily use) ──────────────────────

// --- UI Actions ---

program
  .command("tap")
  .description("Tap at coordinates or element ref")
  .argument("<target...>", 'coordinates "x y" or ref "e5"')
  .action(async (target: string[]) => {
    const client = await getClient();
    let action: Action;
    if (target.length === 1 && target[0].match(/^e\d+$/)) {
      action = { action: "tap", ref: target[0] };
    } else if (target.length === 2) {
      action = { action: "tap", x: parseInt(target[0]), y: parseInt(target[1]) };
    } else {
      console.error('Usage: otacon tap <x> <y> | otacon tap <ref>');
      process.exit(1);
    }
    await client.action(action);
  });

program
  .command("long-tap")
  .description("Long-tap at coordinates or element ref")
  .argument("<target...>", 'coordinates "x y" or ref "e5"')
  .action(async (target: string[]) => {
    const client = await getClient();
    let action: Action;
    if (target.length === 1 && target[0].match(/^e\d+$/)) {
      action = { action: "long_tap", ref: target[0] };
    } else if (target.length === 2) {
      action = { action: "long_tap", x: parseInt(target[0]), y: parseInt(target[1]) };
    } else {
      console.error('Usage: otacon long-tap <x> <y> | otacon long-tap <ref>');
      process.exit(1);
    }
    await client.action(action);
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
    const client = await getClient();
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
    const client = await getClient();
    await client.action({ action: "key", key: name });
  });

program
  .command("type")
  .description("Type text (via ADB input, ASCII only)")
  .argument("<text>", "text to type")
  .action(async (text: string) => {
    const client = await getClient();
    await client.action({ action: "type", text });
  });

program
  .command("set-text")
  .description("Set text on a focused element (supports Unicode)")
  .argument("<ref>", "element ref (e.g. e5)")
  .argument("<text>", "text to set")
  .action(async (ref: string, text: string) => {
    const client = await getClient();
    await client.action({ action: "set_text", ref, text });
  });

program
  .command("pinch")
  .description("Pinch gesture (zoom in/out)")
  .argument("<x>", "center x")
  .argument("<y>", "center y")
  .argument("<start_radius>", "starting finger distance from center")
  .argument("<end_radius>", "ending finger distance (larger = zoom in)")
  .option("-d, --duration <ms>", "duration in ms", "500")
  .action(async (x: string, y: string, sr: string, er: string, opts: { duration: string }) => {
    const client = await getClient();
    await client.action({
      action: "pinch",
      x: parseInt(x),
      y: parseInt(y),
      start_radius: parseInt(sr),
      end_radius: parseInt(er),
      duration_ms: parseInt(opts.duration),
    });
  });

program
  .command("scroll")
  .description("Scroll a scrollable element")
  .argument("<ref>", "element ref (e.g. e5)")
  .option("--up", "scroll up (backward)")
  .action(async (ref: string, opts: { up?: boolean }) => {
    const client = await getClient();
    const action = opts.up ? "scroll_backward" : "scroll_forward";
    await client.action({ action, ref });
  });

// --- Screen ---

program
  .command("screenshot")
  .description("Take a screenshot")
  .option("-o, --output <path>", "output file path (default: screenshot.png)")
  .action(async (opts: { output?: string }) => {
    const client = await getClient();
    const png = await client.screenshot();
    const outPath = opts.output || "screenshot.png";
    writeFileSync(outPath, png);
    console.error(`Saved to ${outPath}`);
  });

program
  .command("snapshot")
  .description("Get accessibility tree")
  .option("--json", "output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const client = await getClient();
    if (opts.json) {
      const result = await client.snapshot("json");
      console.log(JSON.stringify(result, null, 2));
    } else {
      const result = await client.snapshot("text");
      console.log(result);
    }
  });

// --- SMS ---

const sms = program.command("sms").description("SMS commands");

sms
  .command("list")
  .description("List SMS threads")
  .action(async () => {
    const client = await getClient();
    const threads = await client.smsThreads();
    console.log(JSON.stringify(threads, null, 2));
  });

sms
  .command("read")
  .description("Read messages in a thread")
  .argument("<thread_id>", "thread ID")
  .action(async (threadId: string) => {
    const client = await getClient();
    const messages = await client.smsMessages(parseInt(threadId));
    console.log(JSON.stringify(messages, null, 2));
  });

sms
  .command("send")
  .description("Send an SMS")
  .argument("<to>", "phone number")
  .argument("<body>", "message body")
  .action(async (to: string, body: string) => {
    const client = await getClient();
    await client.smsSend(to, body);
  });

// --- Calls ---

const call = program.command("call").description("Call control commands");

call
  .command("dial")
  .description("Dial a phone number")
  .argument("<number>", "phone number to dial")
  .action(async (number: string) => {
    const client = await getClient();
    await client.callDial(number);
  });

call
  .command("answer")
  .description("Answer an incoming call")
  .action(async () => {
    const client = await getClient();
    await client.callAnswer();
  });

call
  .command("hangup")
  .description("End the current call")
  .action(async () => {
    const client = await getClient();
    await client.callHangup();
  });

call
  .command("status")
  .description("Get current call status")
  .action(async () => {
    const client = await getClient();
    const status = await client.callStatus();
    console.log(JSON.stringify(status, null, 2));
  });

// --- Notifications ---

const notifications = program
  .command("notifications")
  .description("Notification commands")
  .enablePositionalOptions(true);

notifications
  .command("list")
  .description("List current notifications")
  .action(async () => {
    const client = await getClient();
    const notifs = await client.notifications();
    console.log(JSON.stringify(notifs, null, 2));
  });

notifications
  .command("dismiss")
  .description("Dismiss a notification by key (use -- before keys starting with -)")
  .argument("<key>", "notification key")
  .passThroughOptions(true)
  .action(async (key: string) => {
    const client = await getClient();
    await client.notificationDismiss(key);
  });

notifications
  .command("action")
  .description("Trigger a notification action button")
  .argument("<key>", "notification key")
  .argument("<index>", "action index (from notifications list)")
  .passThroughOptions(true)
  .action(async (key: string, index: string) => {
    const client = await getClient();
    await client.notificationAction(key, parseInt(index));
  });

// --- Clipboard ---

const clipboard = program
  .command("clipboard")
  .description("Clipboard commands");

clipboard
  .command("get")
  .description("Get clipboard text")
  .action(async () => {
    const client = await getClient();
    const result = await client.clipboardGet();
    if (result.text !== null) {
      console.log(result.text);
    }
  });

clipboard
  .command("set")
  .description("Set clipboard text")
  .argument("<text>", "text to set")
  .action(async (text: string) => {
    const client = await getClient();
    await client.clipboardSet(text);
  });

// --- Apps ---

const apps = program.command("apps").description("App commands");

apps
  .command("list")
  .description("List installed apps (default: table; use --json for raw JSON)")
  .option("--json", "output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const client = await getClient();
    const list = await client.apps();
    printList(list, [
      { header: "PACKAGE", get: (a) => a.package },
      { header: "VERSION", get: (a) => (a as { version_code?: number }).version_code },
      { header: "LABEL", get: (a) => a.label },
    ], { json: opts.json });
  });

apps
  .command("running")
  .description("List running/foreground apps (default: table; use --json for raw JSON)")
  .option("--json", "output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const client = await getClient();
    const list = await client.appsRunning();
    printList(list, [
      { header: "PACKAGE", get: (a) => a.package },
      { header: "LABEL", get: (a) => a.label },
    ], { json: opts.json });
  });

apps
  .command("launch")
  .description("Launch an app")
  .argument("<package>", "package name")
  .action(async (pkg: string) => {
    const client = await getClient();
    await client.appLaunch(pkg);
  });

apps
  .command("stop")
  .description("Force stop an app")
  .argument("<package>", "package name")
  .action(async (pkg: string) => {
    const client = await getClient();
    await client.appStop(pkg);
  });

apps
  .command("install")
  .description("Install an APK")
  .argument("<apk>", "path to APK file")
  .action(async (apk: string) => {
    const client = await getClient();
    const data = readFileSync(apk);
    await client.appInstall(data);
    console.error(`Installed ${apk}`);
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
    const client = await getClient();
    const list = await client.contacts(query);
    console.log(JSON.stringify(list, null, 2));
  });

// --- Device ---

program
  .command("info")
  .description("Device and activity info")
  .action(async () => {
    const client = await getClient();
    const info = await client.info();
    console.log(JSON.stringify(info, null, 2));
  });

// --- Open ---

program
  .command("open")
  .description("Open a URI with the registered app")
  .argument("<uri>", "URI to open (https://, tel:, app deep links, etc.)")
  .action(async (uri: string) => {
    const client = await getClient();
    await client.open(uri);
  });

// --- Recording ---

const record = program
  .command("record")
  .description("Screen recording (interactive: holds TTY, Ctrl+C to stop)")
  .option("-d, --duration <seconds>", "max recording duration", "30")
  .option("-o, --output <path>", "output file path (default: recording.mp4)")
  .action(async (opts: { duration: string; output?: string }) => {
    const client = await getClient();
    const maxDuration = parseInt(opts.duration);
    const outPath = opts.output || "recording.mp4";

    await client.recordStart(maxDuration);

    let stopping = false;
    process.on("SIGINT", async () => {
      if (stopping) return;
      stopping = true;
      process.stderr.write("\nStopping...\n");
      try {
        const mp4 = await client.recordStop();
        writeFileSync(outPath, mp4);
        console.error(`Saved to ${outPath}`);
      } catch (e: unknown) {
        console.error(`Failed to save: ${(e as Error).message}`);
      }
      process.exit(0);
    });

    // Poll status
    for (let i = 1; i <= maxDuration; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (stopping) return;
      try {
        const status = await client.recordStatus();
        if (!status.recording) break;
        process.stderr.write(`\rRecording... ${status.elapsed}s / ${maxDuration}s  [Ctrl+C to stop]`);
      } catch { break; }
    }

    if (!stopping) {
      process.stderr.write("\nAuto-stopped. Saving...\n");
      const mp4 = await client.recordStop();
      writeFileSync(outPath, mp4);
      console.error(`Saved to ${outPath}`);
    }
  });

record
  .command("start")
  .description("Start recording (headless, for agents)")
  .option("-d, --duration <seconds>", "max recording duration", "30")
  .action(async (opts: { duration: string }) => {
    const client = await getClient();
    await client.recordStart(parseInt(opts.duration));
    console.error("Recording started");
  });

record
  .command("stop")
  .description("Stop recording and save video")
  .option("-o, --output <path>", "output file path (default: recording.mp4)")
  .action(async (opts: { output?: string }) => {
    const client = await getClient();
    const mp4 = await client.recordStop();
    const outPath = opts.output || "recording.mp4";
    writeFileSync(outPath, mp4);
    console.error(`Saved to ${outPath}`);
  });

record
  .command("status")
  .description("Check recording status")
  .action(async () => {
    const client = await getClient();
    const status = await client.recordStatus();
    console.log(JSON.stringify(status, null, 2));
  });

// --- Events ---

program
  .command("events")
  .description("Stream device events")
  .option("-f, --follow", "follow event stream")
  .action(async () => {
    // Events are a registry-level concept for now
    console.error("Events streaming not yet implemented in CLI");
    process.exit(1);
  });

// --- Run ---

program.parseAsync().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
