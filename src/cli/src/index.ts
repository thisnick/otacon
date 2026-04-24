#!/usr/bin/env node
// Accept Tailscale self-signed certs (set before any imports to avoid warning)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { Command, program } from "commander";
import { readFileSync, writeFileSync } from "fs";
import type { Action } from "./client.js";
import { getHostClient } from "./host-client.js";
import { authCommands } from "./commands/auth.js";
import { regCommands } from "./commands/reg.js";
import { phoneCommands } from "./commands/phone.js";
import { configCommands } from "./commands/config.js";
import { simCommands } from "./commands/phone-esim.js";
import { apnCommands } from "./commands/phone-apns.js";
import { hostCommands } from "./commands/host.js";
import { dongleCommands } from "./commands/dongle.js";
import { printDetail, printList } from "./format.js";
import { clientCommands } from "./commands/client.js";
import { wifiCommands } from "./commands/wifi.js";

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

type CliRecord = Record<string, unknown>;

function jsonOut(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function asRecord(value: unknown): CliRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as CliRecord
    : {};
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function status(value: unknown, yes: string, no: string): string {
  return value ? yes : no;
}

function seconds(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const mins = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function printSection(title: string, rows: Array<[string, unknown]>, first = false): void {
  if (!first) console.log("");
  console.log(title);
  if (rows.length === 0) {
    console.log("-");
    return;
  }
  const width = Math.max(...rows.map(([key]) => key.length));
  for (const [key, value] of rows) {
    console.log(`${key.padEnd(width)}  ${cell(value)}`);
  }
}

function flattenRecord(record: CliRecord, prefix = "", depth = 0): Array<[string, unknown]> {
  const rows: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(record)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value) && depth < 2) {
      rows.push(...flattenRecord(value as CliRecord, label, depth + 1));
    } else if (Array.isArray(value)) {
      rows.push([label, value.length === 0 ? "-" : `${value.length} item${value.length === 1 ? "" : "s"}`]);
    } else {
      rows.push([label, value]);
    }
  }
  return rows;
}

function printDeviceInfo(info: CliRecord): void {
  const wifi = asRecord(info.wifi);
  const stats = asRecord(info.stats);
  const memUsed = stats.mem_used_mb;
  const memTotal = stats.mem_total_mb;
  const memory =
    typeof memUsed === "number" && typeof memTotal === "number"
      ? `${memUsed} / ${memTotal} MB`
      : "-";
  const cpu = typeof stats.cpu_pct === "number" ? `${stats.cpu_pct.toFixed(1)}%` : "-";
  const battery = typeof stats.battery_pct === "number" ? `${stats.battery_pct}%` : "-";
  const temp = typeof stats.temp_c === "number" ? `${stats.temp_c.toFixed(1)} C` : "-";
  const wifiStatus = wifi.connected
    ? `connected${wifi.ssid ? `  ${wifi.ssid}` : ""}${wifi.rssi ? `  ${wifi.rssi} dBm` : ""}`
    : status(wifi.enabled, "enabled", "disabled");

  printSection("DEVICE", [
    ["model", info.model],
    ["adb_serial", info.adb_serial],
    ["screen_state", info.screen_state],
    ["resolution", info.resolution],
    ["vnc_port", info.vnc_port],
  ], true);

  printSection("CONNECTIONS", [
    ["device_owner", status(info.bridge, "online", "offline")],
    ["snapshot_server", status(info.snapshot_server, "online", "offline")],
    ["bluetooth", status(info.bt_connected, "connected", "disconnected")],
    ["adapter_mac", info.adapter_mac],
    ["phone_bt_mac", info.phone_bt_mac],
    ["wifi", wifiStatus],
  ]);

  printSection("IDENTITY", [
    ["phone_number", info.phone_number],
    ["imei", info.imei],
    ["imei2", info.imei2],
    ["eid", info.eid],
  ]);

  printSection("CURRENT APP", [
    ["activity", info.activity],
    ["window", info.window],
  ]);

  printSection("STATS", [
    ["battery", battery],
    ["memory", memory],
    ["cpu", cpu],
    ["temperature", temp],
  ]);

  if (info.monitor) {
    printSection("MONITOR", flattenRecord(asRecord(info.monitor)));
  }
}

// ── Subcommand groups ─────────────────────────────────────────────

const getParentOpts = () => program.opts() as { host?: string; phone?: string; registry?: string };

program.addCommand(authCommands());
program.addCommand(regCommands(getParentOpts));
program.addCommand(configCommands(getParentOpts));
program.addCommand(hostCommands(getParentOpts));
program.addCommand(hostCommands(getParentOpts, "host"), { hidden: true });
program.addCommand(dongleCommands(getParentOpts));
program.addCommand(dongleCommands(getParentOpts, "dongle"), { hidden: true });
program.addCommand(clientCommands(getParentOpts));
program.addCommand(clientCommands(getParentOpts, "client"), { hidden: true });
program.addCommand(simCommands(getParentOpts));
program.addCommand(apnCommands(getParentOpts));
program.addCommand(wifiCommands(getParentOpts));
program.addCommand(phoneCommands(getParentOpts));
program.addCommand(phoneCommands(getParentOpts, "phone"), { hidden: true });

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
  .description("List SMS threads (default: table; use --json for raw JSON)")
  .option("--json", "output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const client = await getClient();
    const threads = await client.smsThreads();
    printList(threads, [
      { header: "THREAD", get: (t) => t.thread_id },
      { header: "ADDRESS", get: (t) => t.address },
      { header: "DATE", get: (t) => t.date },
      { header: "SNIPPET", get: (t) => t.snippet, maxWidth: 64 },
    ], { json: opts.json });
  });

sms
  .command("read")
  .description("Read messages in a thread (default: table; use --json for raw JSON)")
  .argument("<thread_id>", "thread ID")
  .option("--json", "output as JSON")
  .action(async (threadId: string, opts: { json?: boolean }) => {
    const client = await getClient();
    const messages = await client.smsMessages(parseInt(threadId));
    printList(messages, [
      { header: "ID", get: (m) => m.id },
      { header: "DATE", get: (m) => m.date },
      { header: "TYPE", get: (m) => m.type },
      { header: "ADDRESS", get: (m) => m.address },
      { header: "BODY", get: (m) => m.body, maxWidth: 80 },
    ], { json: opts.json });
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
  .description("Get current call status (default: detail; use --json for raw JSON)")
  .option("--json", "output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const client = await getClient();
    const status = await client.callStatus();
    if (opts.json) {
      jsonOut(status);
      return;
    }
    const record = status as unknown as CliRecord;
    printDetail({
      state: record.state,
      number: record.number,
      duration: seconds(record.duration),
    });
  });

// --- Notifications ---

const notifications = program
  .command("notifications")
  .description("Notification commands")
  .enablePositionalOptions(true);

notifications
  .command("list")
  .description("List current notifications (default: table; use --json for raw JSON)")
  .option("--json", "output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const client = await getClient();
    const notifs = await client.notifications();
    printList(notifs, [
      { header: "PACKAGE", get: (n) => n.package },
      { header: "TITLE", get: (n) => n.title, maxWidth: 32 },
      { header: "TEXT", get: (n) => n.text, maxWidth: 56 },
      {
        header: "ACTIONS",
        get: (n) => (n.actions ?? []).map((a) => `[${a.index}] ${a.title}`).join(" "),
        maxWidth: 56,
      },
      { header: "KEY", get: (n) => n.key, maxWidth: 36 },
    ], { json: opts.json });
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

function appCommands(name: string): Command {
  const app = new Command(name).description("App commands");

  app
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

  app
    .command("running")
    .description("List running/foreground apps (default: table; use --json for raw JSON)")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = await getClient();
      const result = await client.appsRunning();
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.apps.length === 0 && result.screen_state !== "unlocked") {
        console.error(
          `(no running apps — phone is ${result.screen_state}. ` +
            `Wake with: otacon key wake)`
        );
        return;
      }
      printList(result.apps, [
        { header: "PACKAGE", get: (a) => a.package },
        { header: "LABEL", get: (a) => a.label },
      ]);
    });

  app
    .command("launch")
    .description("Launch an app")
    .argument("<package>", "package name")
    .action(async (pkg: string) => {
      const client = await getClient();
      await client.appLaunch(pkg);
    });

  app
    .command("stop")
    .description("Force stop an app")
    .argument("<package>", "package name")
    .action(async (pkg: string) => {
      const client = await getClient();
      await client.appStop(pkg);
    });

  app
    .command("install")
    .description("Install an APK")
    .argument("<apk>", "path to APK file")
    .action(async (apk: string) => {
      const client = await getClient();
      const data = readFileSync(apk);
      await client.appInstall(data);
      console.error(`Installed ${apk}`);
    });

  return app;
}

program.addCommand(appCommands("apps"));
program.addCommand(appCommands("app"), { hidden: true });

// --- Contacts ---

const contacts = program
  .command("contacts")
  .description("Contact commands");

contacts
  .command("search")
  .description("Search contacts (default: table; use --json for raw JSON)")
  .argument("<query>", "search query")
  .option("--json", "output as JSON")
  .action(async (query: string, opts: { json?: boolean }) => {
    const client = await getClient();
    const list = await client.contacts(query);
    printList(list, [
      { header: "NAME", get: (c) => c.name },
      { header: "PHONES", get: (c) => c.phones.join(", "), maxWidth: 80 },
    ], { json: opts.json });
  });

// --- Device ---

program
  .command("info")
  .description("Device and activity info (default: sections; use --json for raw JSON)")
  .option("--monitor", "include the fleet-agent monitor status blob (verbose)")
  .option("--json", "output as JSON")
  .action(async (opts: { monitor?: boolean; json?: boolean }) => {
    const client = await getClient();
    const info = await client.info() as Record<string, unknown>;
    if (!opts.monitor && "monitor" in info) {
      delete info.monitor;
    }
    if (opts.json) {
      jsonOut(info);
      return;
    }
    printDeviceInfo(info);
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
  .option("-d, --duration <seconds>", "max recording duration", "300")
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
  .option("-d, --duration <seconds>", "max recording duration", "300")
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
  .description("Check recording status (default: detail; use --json for raw JSON)")
  .option("--json", "output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const client = await getClient();
    const status = await client.recordStatus();
    if (opts.json) {
      jsonOut(status);
      return;
    }
    printDetail({
      recording: status.recording ? "yes" : "no",
      elapsed: seconds(status.elapsed),
      max_duration: seconds(status.max_duration),
      remaining:
        typeof status.elapsed === "number" && typeof status.max_duration === "number"
          ? seconds(Math.max(status.max_duration - status.elapsed, 0))
          : "-",
    });
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
