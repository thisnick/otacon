import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OtaconVoiceRuntime } from "../src/runtime.js";
import { config, FakeLink, fakeApi, fakeSdk, fakeSecrets, logs, settle } from "./fakes.js";

const ALLOWED = "+15555550102";

function setup(extra: Record<string, unknown> = {}, transcriptsDir?: string) {
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
    links: { sim: link },
    createDetector: async () => null,
    transcriptsDir,
  });
  return { rt, link, sdk, sessions, events, wakes, consults };
}

/** Place a call to Luigi's, hear one line, and let it end. */
async function oneCall(s: ReturnType<typeof setup>, heard: string) {
  const { missionId } = await s.rt.startCall({ to: "+15555550100", name: "Luigi's", brief: "Book a table", agentId: "main", requesterSessionKey: "agent:main:chat-1" });
  await settle();
  s.link.call("call.state", { id: "o1", number: "+15555550100", state: "active" });
  await settle();
  s.sessions.at(-1)!.transcript("user", heard);
  s.link.call("call.ended", { id: "o1" }, "remote");
  await settle();
  s.sessions.at(-1)!.transcript("user", "Bye!"); // the last words the mission waits for
  await settle();
  return missionId;
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
  assert.match(events[0].text, /Incoming call from \+15555550102 to sim ended \(completed/);
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
  assert.equal((rt as any).slots.get("sim").mission.o.holdLimitSeconds, 1800, "a hold limit is capped by the call's");
  await assert.rejects(rt.startCall({ to: "+15555550100", brief: "again", agentId: "main" }), /already in progress/);
  await assert.rejects(rt.startCall({ to: "5551234", brief: "x", agentId: "main" }).catch((e) => Promise.reject(e)), /already in progress|E.164/);
  link.call("call.ended", { id: "o1" }, "failed");
  await settle();
  assert.equal(events[0].sessionKey, "agent:main:chat-1");
  assert.match(events[0].text, /placed to Luigi's \(\+15555550100\) from sim has ended \(no_answer/);
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

test("lines: calls go out on the default line or the one named, one call per line, at once", async () => {
  const sim = new FakeLink();
  const other = new FakeLink();
  for (const [l, id] of [[sim, "s1"], [other, "o1"]] as const)
    l.handler = (type, f) => {
      if (type !== "dial") return {};
      l.call("call.state", { id, number: f.to, state: "dialing" });
      return { call: l.calls.get(id) };
    };
  const { sdk } = fakeSdk();
  const { api } = fakeApi();
  const cfg = config({
    lines: [
      { id: "sim", provider: "otacon", url: "https://otacon.test:8080", phoneId: "phone-test" },
      { id: "other", provider: "otacon", url: "https://otacon.test:8080", phoneId: "phone-other", number: "+15550008888" },
    ],
    defaultLine: "other",
  });
  const rt = new OtaconVoiceRuntime(api, cfg, sdk, { links: { sim, other }, createDetector: async () => null });
  await rt.start();
  try {
    await rt.startCall({ to: "+15555550100", brief: "x", agentId: "main" });
    await settle();
    assert.equal(other.cmds[0]?.type, "dial", "the default line");
    await assert.rejects(rt.startCall({ to: "+15555550100", brief: "x", agentId: "main" }), /already in progress on line other/);
    await rt.startCall({ to: "+15555550101", brief: "x", agentId: "main", line: "sim" });
    await settle();
    assert.equal(sim.cmds[0]?.type, "dial", "a second call on the other line, at the same time");
    await assert.rejects(rt.startCall({ to: "+15555550100", brief: "x", agentId: "main", line: "nope" }), /no line nope; lines: sim, other/);
    assert.deepEqual(rt.lines.map((l) => [l.id, l.number]), [["sim", undefined], ["other", "+15550008888"]]);
  } finally {
    sim.call("call.ended", { id: "s1" }, "failed");
    other.call("call.ended", { id: "o1" }, "failed");
    await settle();
  }
});

test("transcripts: each finished call is saved whole, and the report says where", async () => {
  const dir = mkdtempSync(join(tmpdir(), "otacon-voice-calls-"));
  try {
    const s = setup({}, join(dir, "calls"));
    await s.rt.start();
    const id = await oneCall(s, "Yes, a table for two at 7:30.");
    const files = readdirSync(join(dir, "calls"));
    assert.deepEqual(files, [`${new Date().toISOString().slice(0, 10)}-${id}.txt`]);
    const saved = readFileSync(join(dir, "calls", files[0]), "utf8");
    assert.match(saved, /TL;DR: none/);
    assert.match(saved, /Luigi's: Yes, a table for two at 7:30\./);
    assert.doesNotMatch(saved, /otacon_call_log/, "the saved copy doesn't point at itself");
    assert.match(s.events[0].text, new RegExp(`Full transcript: otacon_call_log with callId ${id} \\(saved at ${join(dir, "calls", files[0]).replace(/[.]/g, "\\.")}\\)`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcripts: otacon_call_log reads a call by id, or the latest, and after a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "otacon-voice-calls-"));
  try {
    const s = setup({}, dir);
    await s.rt.start();
    const first = await oneCall(s, "First call.");
    const second = await oneCall(s, "Second call.");
    assert.match(s.rt.callLog(first)!.transcript, /First call\./);
    assert.equal(s.rt.callLog()!.callId, second, "no id: the latest call");
    assert.equal(s.rt.callLog("oc_00000000"), null);
    s.rt.stop();

    // A new runtime (the gateway restarted) has nothing in memory, only the files.
    const again = setup({}, dir);
    await again.rt.start();
    const log = again.rt.callLog(first)!;
    assert.match(log.transcript, /First call\./);
    assert.ok(log.savedAt?.startsWith(dir));
    again.rt.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcripts: when saving fails, the call is still reported, without a file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "otacon-voice-calls-"));
  const notADir = join(dir, "file");
  writeFileSync(notADir, "");
  try {
    const s = setup({}, notADir);
    await s.rt.start();
    const id = await oneCall(s, "Hello.");
    assert.equal(s.events.length, 1);
    assert.match(s.events[0].text, new RegExp(`otacon_call_log with callId ${id}\\.`));
    assert.doesNotMatch(s.events[0].text, /saved at/);
    assert.match(s.rt.callLog(id)!.transcript, /Hello\./, "still readable from memory");
    assert.ok(!existsSync(join(notADir, "x")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
