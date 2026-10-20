import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";

const base = { lines: [{ id: "sim", provider: "otacon", url: "https://pi.example:8080/", phoneId: "phone-x" }] };

test("defaults", () => {
  const { config, errors } = parseConfig(base);
  assert.deepEqual(errors, []);
  assert.deepEqual(config!.lines, [{ id: "sim", provider: "otacon", url: "https://pi.example:8080", phoneId: "phone-x", takeover: false, number: undefined }]);
  assert.equal(config!.defaultLine, "sim");
  assert.equal(config!.inboundPolicy, "disabled");
  assert.equal(config!.toolPolicy, "safe-read-only");
  assert.equal(config!.holdCapSeconds, 300);
  // A realtime model is always pinned (the provider default can't run tools).
  assert.equal(config!.realtime.providers.openai.model, "gpt-realtime-2.1");
});

test("required and invalid fields", () => {
  assert.deepEqual(parseConfig({}).errors, ["lines: at least one line is required"]);
  assert.deepEqual(parseConfig({ lines: [{ id: "sim", provider: "otacon" }] }).errors, ["lines[0] (sim).url is required", "lines[0] (sim).phoneId is required"]);
  const r = parseConfig({ ...base, allowFrom: ["5551234"], contacts: { a: { number: "123" } } });
  assert.equal(r.config, undefined);
  assert.ok(r.errors.some((e) => e.includes("allowFrom")));
  assert.ok(r.errors.some((e) => e.includes("contacts.a.number")));
});

test("contacts and clamps", () => {
  const { config } = parseConfig({
    ...base,
    contacts: { nick: { name: "Nick", number: "+15550001111", description: "owner" } },
    holdCapSeconds: 1,
    inboundPolicy: "allowlist",
    allowFrom: ["+15550002222"],
  });
  assert.deepEqual(config!.contacts, [{ id: "nick", name: "Nick", number: "+15550001111", description: "owner" }]);
  assert.equal(config!.holdCapSeconds, 10);
  assert.equal(config!.inboundPolicy, "allowlist");
});

test("consult thinking level and fast mode", () => {
  const { config } = parseConfig({ ...base, consultThinkingLevel: "low", consultFastMode: true });
  assert.equal(config!.consultThinkingLevel, "low");
  assert.equal(config!.consultFastMode, true);
  assert.equal(parseConfig(base).config!.consultThinkingLevel, undefined);
  assert.ok(parseConfig({ ...base, consultThinkingLevel: "loud" }).errors[0].includes("consultThinkingLevel"));
});

test("sessionScope defaults to per-phone", () => {
  assert.equal(parseConfig(base).config!.sessionScope, "per-phone");
  assert.equal(parseConfig({ ...base, sessionScope: "per-call" }).config!.sessionScope, "per-call");
  assert.equal(parseConfig({ ...base, sessionScope: "nope" }).config!.sessionScope, "per-phone");
});

test("the phone-menu navigator and the inbound greeting: defaults and overrides", () => {
  const d = parseConfig(base).config!;
  assert.equal(d.inboundGreeting, "Hello! How can I help you today?");
  assert.equal(parseConfig({ ...base, inboundGreeting: " I'm the bot. " }).config!.inboundGreeting, "I'm the bot.");
  assert.equal(d.menu.enabled, true);
  assert.equal(d.menu.transcription.model, "gpt-live-transcribe");
  assert.equal(d.menu.transcription.delay, "medium");
  assert.equal(d.menu.decisions.model, "openai/gpt-6-luna-decisions");
  assert.deepEqual([d.menu.checkEverySeconds, d.menu.threshold], [3, 0.6]);
  const ref = { source: "store", provider: "default", id: "OTACON_VOICE_OPENROUTER_API_KEY" };
  const c = parseConfig({ ...base, menu: { enabled: false, transcription: { delay: "high" }, decisions: { apiKey: ref }, threshold: 0.7 } }).config!;
  assert.equal(c.menu.enabled, false);
  assert.equal(c.menu.transcription.delay, "high");
  assert.deepEqual(c.menu.decisions.apiKey, ref);
  assert.equal(c.menu.threshold, 0.7);
});

test("agent context: off by default, voice-call's files and size when on", () => {
  assert.equal(parseConfig(base).config!.realtime.agentContext.enabled, false);
  const c = parseConfig({ ...base, realtime: { agentContext: { enabled: true } } }).config!.realtime.agentContext;
  assert.deepEqual(c, { enabled: true, includeIdentity: true, includeWorkspaceFiles: true, files: ["SOUL.md", "IDENTITY.md", "USER.md"], maxChars: 6000 });
});

test("lines: otacon and Twilio, the default, and their errors", () => {
  const tw = { id: "tw", provider: "twilio", accountSid: "AC1", authToken: { source: "store", provider: "default", id: "T" }, fromNumber: "+15550009999", publicUrl: "https://gw.example/otacon-voice/twilio/tw/" };
  const c = parseConfig({ lines: [base.lines[0], tw], defaultLine: "tw" }).config!;
  assert.equal(c.defaultLine, "tw");
  assert.deepEqual(c.lines[1], { ...tw, publicUrl: "https://gw.example/otacon-voice/twilio/tw", number: "+15550009999" });
  assert.deepEqual(parseConfig({ lines: [base.lines[0]], defaultLine: "nope" }).errors, ["defaultLine: no line nope"]);
  assert.deepEqual(parseConfig({ lines: [base.lines[0], base.lines[0]] }).errors, ["lines[1] (sim): duplicate id"]);
  const bad = parseConfig({ lines: [{ id: "tw", provider: "twilio", fromNumber: "555", publicUrl: "http://x" }, { id: "x", provider: "sip" }] }).errors;
  assert.deepEqual(bad, [
    "lines[0] (tw).accountSid is required",
    "lines[0] (tw).authToken is required",
    "lines[0] (tw).fromNumber must be E.164",
    "lines[0] (tw).publicUrl must be an https URL",
    'lines[1] (x).provider must be "otacon" or "twilio"',
  ]);
});

test("listen: a number to call, and a Twilio line to call from", () => {
  const tw = { id: "tw", provider: "twilio", accountSid: "AC1", authToken: "t", fromNumber: "+15550009999", publicUrl: "https://gw.example/x" };
  assert.deepEqual(parseConfig({ lines: [base.lines[0], tw], listen: { to: "+15550004444" } }).config!.listen, { to: "+15550004444", line: undefined });
  assert.deepEqual(parseConfig({ lines: [base.lines[0]], listen: { to: "+15550004444" } }).errors, ["listen needs a Twilio line to dial from"]);
  assert.deepEqual(parseConfig({ lines: [base.lines[0], tw], listen: { to: "+15550004444", line: "sim" } }).errors, ["listen.line: sim isn't a Twilio line"]);
  assert.deepEqual(parseConfig({ lines: [base.lines[0], tw], listen: { to: "555" } }).errors, ["listen.to must be E.164"]);
  assert.equal(parseConfig({ lines: [base.lines[0], tw] }).config!.listen, undefined);
});

test("the manifest declares every tool the plugin registers (OpenClaw drops undeclared ones)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
  const manifest = JSON.parse(fs.readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"));
  const registered = new Set([...src.matchAll(/name: "(otacon_[a-z_]+)"/g)].map((m) => m[1]));
  registered.add("otacon_call"); // registered through TOOL_NAME
  assert.deepEqual([...registered].sort(), [...manifest.contracts.tools].sort());
});
