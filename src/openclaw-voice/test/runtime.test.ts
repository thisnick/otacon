import assert from "node:assert/strict";
import { test } from "node:test";
import { OtaconVoiceRuntime } from "../src/runtime.js";
import { config, FakeLink, fakeApi, fakeSdk, settle } from "./fakes.js";

const ALLOWED = "+15555550102";

function setup(extra: Record<string, unknown> = {}) {
  const link = new FakeLink();
  const { sdk, sessions, consults } = fakeSdk();
  const { api, events, wakes } = fakeApi();
  link.handler = (type, f) => {
    if (type === "answer") {
      link.call("call.state", { id: f.call, state: "active", direction: "incoming" });
      return { call: link.calls.get(f.call) };
    }
    if (type === "dial") {
      link.call("call.state", { id: "o1", number: f.to, state: "dialing" });
      return { call: link.calls.get("o1") };
    }
    return {};
  };
  const rt = new OtaconVoiceRuntime(api, config({ inboundPolicy: "allowlist", allowFrom: [ALLOWED], ...extra }), sdk, {
    link,
    createDetector: async () => null,
  });
  return { rt, link, sessions, events, wakes, consults };
}

test("inbound: callers not on the allowlist are left ringing", async () => {
  const { rt, link } = setup();
  await rt.start();
  link.call("call.incoming", { id: "i1", number: "+15555550199", direction: "incoming", state: "incoming" });
  link.call("call.incoming", { id: "i2", number: null, direction: "incoming", state: "incoming" });
  await settle();
  assert.deepEqual(link.cmds, []);
});

test("inbound: allowlisted callers are answered, and the call is reported to main", async () => {
  const { rt, link, sessions, events, wakes } = setup();
  await rt.start();
  link.call("call.incoming", { id: "i1", number: ALLOWED, direction: "incoming", state: "incoming" });
  await settle();
  assert.deepEqual(link.cmds[0], { type: "answer", fields: { call: "i1" } });
  assert.equal(sessions.length, 1);
  sessions[0].transcript("user", "Hi, it's me");
  link.call("call.ended", { id: "i1" }, "remote");
  await settle();
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionKey, "agent:main:main");
  assert.match(events[0].text, /Incoming call from \+15555550102 ended \(completed/);
  assert.match(events[0].text, /\+15555550102: Hi, it's me/);
  assert.equal(wakes.length, 1, "the agent is woken to read it");
});

test("inbound: inboundSessionKey gets the report, and consults fork it", async () => {
  const chat = "agent:main:whatsapp:direct:+15555550102";
  const { rt, link, sessions, events, consults } = setup({ inboundSessionKey: chat });
  await rt.start();
  link.call("call.incoming", { id: "i1", number: ALLOWED, direction: "incoming", state: "incoming" });
  await settle();
  await sessions[0].tool("openclaw_agent_consult", { question: "What's on my calendar?" });
  assert.equal(consults[0].spawnedBy, chat);
  link.call("call.ended", { id: "i1" }, "remote");
  await settle();
  assert.equal(events[0].sessionKey, chat);
});

test("outbound: one call at a time; the report goes to the requesting session", async () => {
  const { rt, link, events } = setup();
  await rt.start();
  const { missionId } = await rt.startCall({
    to: "+15555550100",
    name: "Luigi's",
    brief: "Book a table",
    agentId: "main",
    requesterSessionKey: "agent:main:chat-1",
  });
  await settle();
  await assert.rejects(rt.startCall({ to: "+15555550100", brief: "again", agentId: "main" }), /already in progress/);
  await assert.rejects(rt.startCall({ to: "5551234", brief: "x", agentId: "main" }).catch((e) => Promise.reject(e)), /already in progress|E.164/);
  link.call("call.ended", { id: "o1" }, "failed");
  await settle();
  assert.equal(events[0].sessionKey, "agent:main:chat-1");
  assert.match(events[0].text, /placed to Luigi's \(\+15555550100\) has ended \(no_answer/);
  assert.equal(rt.status(missionId)?.ended, true);
});
