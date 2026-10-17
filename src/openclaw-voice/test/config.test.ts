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
