import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";

const base = { otacon: { url: "https://pi.example:8080/", phoneId: "phone-x" } };

test("defaults", () => {
  const { config, errors } = parseConfig(base);
  assert.deepEqual(errors, []);
  assert.equal(config!.otacon.url, "https://pi.example:8080");
  assert.equal(config!.inboundPolicy, "disabled");
  assert.equal(config!.toolPolicy, "safe-read-only");
  assert.equal(config!.holdCapSeconds, 300);
  // A realtime model is always pinned (the provider default can't run tools).
  assert.equal(config!.realtime.providers.openai.model, "gpt-realtime-2.1");
});

test("required and invalid fields", () => {
  assert.deepEqual(parseConfig({}).errors, ["otacon.url is required", "otacon.phoneId is required"]);
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

test("the phone-menu navigator and the consult filler: defaults and overrides", () => {
  const d = parseConfig(base).config!;
  assert.equal(d.consultFiller, "Checking.");
  assert.equal(d.menu.enabled, true);
  assert.equal(d.menu.transcription.model, "gpt-live-transcribe");
  assert.equal(d.menu.transcription.delay, "medium");
  assert.equal(d.menu.decisions.model, "openai/gpt-6-luna-decisions");
  assert.deepEqual([d.menu.checkEverySeconds, d.menu.threshold], [3, 0.6]);
  const ref = { source: "store", provider: "default", id: "OTACON_VOICE_OPENROUTER_API_KEY" };
  const c = parseConfig({ ...base, consultFiller: "", menu: { enabled: false, transcription: { delay: "high" }, decisions: { apiKey: ref }, threshold: 0.7 } }).config!;
  assert.equal(c.consultFiller, "");
  assert.equal(c.menu.enabled, false);
  assert.equal(c.menu.transcription.delay, "high");
  assert.deepEqual(c.menu.decisions.apiKey, ref);
  assert.equal(c.menu.threshold, 0.7);
});
