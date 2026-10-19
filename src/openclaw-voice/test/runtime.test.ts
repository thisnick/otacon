import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import { OtaconVoiceRuntime } from "../src/runtime.js";
import { config, FakeLink, fakeApi, fakeSdk, fakeSecrets, logs, settle } from "./fakes.js";

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
  return { rt, link, sdk, sessions, events, wakes, consults };
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
  sessions[0].transcript("user", "Bye!"); // the last words the mission waits for
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
  sessions[0].transcript("user", "Bye!");
  await settle();
  assert.equal(events[0].sessionKey, chat);
});

test("outbound: a call placed from an agent turn outlives the turn's async scope", async () => {
  // OpenClaw closes an agent turn's async work scope when the turn ends, and
  // work still running in it fails. Here the turn's scope is a store.
  const turn = new AsyncLocalStorage<{ closed: boolean }>();
  const { rt, link, sdk, sessions } = setup();
  const consult = sdk.consult;
  sdk.consult = async (p) => {
    if (turn.getStore()?.closed) throw new Error("Async work scope is closed");
    return consult(p);
  };
  await rt.start();
  const scope = { closed: false };
  await turn.run(scope, () =>
    rt.startCall({ to: "+15555550100", brief: "Is the prescription ready?", agentId: "main", requesterSessionKey: "agent:main:main" }),
  );
  scope.closed = true; // the tool returned and the turn ended
  await settle();
  link.call("call.state", { id: "o1", number: "+15555550100", state: "active" }); // they answer
  await settle();
  try {
    const r = await sessions[0].tool("openclaw_agent_consult", { question: "What's Nick's date of birth?" });
    assert.deepEqual(r.result, { text: "Nick prefers 7:30." });
  } finally {
    link.call("call.ended", { id: "o1" }, "remote"); // or its timers keep the test process alive
    await settle();
  }
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
    holdLimitSeconds: 99_999,
  });
  await settle();
  assert.equal((rt as any).mission.o.holdLimitSeconds, 1800, "a hold limit is capped by the call's");
  await assert.rejects(rt.startCall({ to: "+15555550100", brief: "again", agentId: "main" }), /already in progress/);
  await assert.rejects(rt.startCall({ to: "5551234", brief: "x", agentId: "main" }).catch((e) => Promise.reject(e)), /already in progress|E.164/);
  link.call("call.ended", { id: "o1" }, "failed");
  await settle();
  assert.equal(events[0].sessionKey, "agent:main:chat-1");
  assert.match(events[0].text, /placed to Luigi's \(\+15555550100\) has ended \(no_answer/);
  assert.equal(rt.status(missionId)?.ended, true);
});

test("the phone-menu navigator: on with an OpenRouter key (a SecretRef) and the realtime OpenAI key; off without the key", async () => {
  fakeSecrets.OPENROUTER_TEST = "sk-or-test";
  const on = setup({
    menu: { decisions: { apiKey: { source: "store", provider: "default", id: "OPENROUTER_TEST" } } },
    realtime: { providers: { openai: { apiKey: "sk-test" } } },
  });
  logs.length = 0;
  await on.rt.start();
  assert.ok(logs.some((l) => /phone-menu navigator on \(openai\/gpt-6-luna-decisions; gpt-live-transcribe, delay medium\)/.test(l)), logs.join("\n"));
  on.rt.stop();

  const off = setup();
  logs.length = 0;
  await off.rt.start();
  assert.ok(logs.some((l) => /navigator off: no OpenRouter key/.test(l)));
  off.rt.stop();
});
