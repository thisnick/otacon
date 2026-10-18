import assert from "node:assert/strict";
import { test } from "node:test";
import { callSessionKey } from "../src/session.js";
import { fakeSessionKeys as sdk } from "./fakes.js";

const base = { cfg: {}, agentId: "main", callId: "oc_1234abcd", phone: "+1 (555) 555-0100" };

test("per-phone (default): one session per number, digits only", () => {
  assert.equal(callSessionKey(sdk, { ...base, scope: "per-phone" }), "agent:main:voice:15555550100");
  // No number (withheld caller ID): the call's own session.
  assert.equal(callSessionKey(sdk, { ...base, scope: "per-phone", phone: null }), "agent:main:voice:oc_1234abcd");
});

test("per-call and main", () => {
  assert.equal(callSessionKey(sdk, { ...base, scope: "per-call" }), "agent:main:voice:call:oc_1234abcd");
  assert.equal(callSessionKey(sdk, { ...base, scope: "main" }), "agent:main:main");
  assert.equal(callSessionKey(sdk, { ...base, cfg: { session: { scope: "global" } }, scope: "main" }), "global");
});

test("an explicit key wins, in the call's agent's namespace", () => {
  const key = (explicit: string, agentId = "main") => callSessionKey(sdk, { ...base, agentId, scope: "per-phone", explicit });
  assert.equal(key("agent:main:whatsapp:direct:+15555550101"), "agent:main:whatsapp:direct:+15555550101");
  assert.equal(key("bookings"), "agent:main:bookings");
  assert.equal(key("  agent:Main:x  ", "Main"), "agent:main:x");
  // Another agent's key is kept under this agent, as the stock plugin does.
  assert.equal(key("agent:eta:main"), "agent:main:agent:eta:main");
  assert.equal(key("global"), "global");
});
