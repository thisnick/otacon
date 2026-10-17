import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { CallMission, type MissionReport } from "../src/call.js";
import type { Contact } from "../src/config.js";
import { config, FakeDetector, FakeLink, fakeApi, fakeSdk, frame, settle } from "./fakes.js";

const BIZ = "+15555550100";
const NICK: Contact = { id: "nick", name: "Nick", number: "+15555550101" };

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"] }));
afterEach(() => mock.timers.reset());

function setup(o: { direction?: "outbound" | "inbound"; contacts?: Contact[]; cfg?: Record<string, unknown> } = {}) {
  const link = new FakeLink();
  const { sdk, sessions, consults } = fakeSdk();
  const { api } = fakeApi();
  const detector = new FakeDetector();
  const reports: MissionReport[] = [];
  let next = 0;
  link.handler = (type, f) => {
    if (type === "dial") {
      const id = `c${++next}`;
      link.call("call.state", { id, number: f.to, state: "dialing" });
      return { call: link.calls.get(id) };
    }
    if (type === "answer") {
      link.call("call.state", { id: f.call, state: "active", direction: "incoming" });
      return { call: link.calls.get(f.call) };
    }
    if (type === "dtmf") return { digits: f.digits };
    return {};
  };
  const m = new CallMission({
    api,
    config: config({ holdCapSeconds: 60, ringTimeoutSeconds: 20, ...o.cfg }),
    link,
    sdk,
    detector,
    direction: o.direction ?? "outbound",
    party: { name: "Bright Smile Dental", number: BIZ, role: "primary" },
    inboundCallId: o.direction === "inbound" ? "in1" : undefined,
    brief: "Move the cleaning to Thursday 2 PM",
    contacts: o.contacts ?? [],
    agentId: "main",
    requesterSessionKey: "agent:main:main",
    onEnd: (r) => reports.push(r),
  });
  return { m, link, sessions, consults, detector, reports };
}

/** Start an outbound call and have it answered. */
async function connected(o: Parameters<typeof setup>[0] = {}) {
  const t = setup(o);
  t.m.start();
  await settle();
  t.link.call("call.state", { id: "c1", state: "active" });
  await settle();
  assert.equal(t.sessions.length, 1, "realtime session started");
  return { ...t, s: t.sessions[0] };
}

test("outbound: dials, starts the model on answer, pipes audio both ways", async () => {
  const { link, s } = await connected();
  assert.deepEqual(link.cmds[0], { type: "dial", fields: { to: BIZ } });
  assert.match(s.params.instructions, /Move the cleaning to Thursday 2 PM/);
  assert.deepEqual(
    s.params.tools.map((t: any) => t.name),
    ["send_dtmf", "wait_on_hold", "end_call", "openclaw_agent_consult"],
  );
  link.emit("audio", frame());
  assert.equal(s.audioIn.length, 1, "phone audio reaches the model");
  s.speak(Buffer.alloc(960));
  assert.equal(link.sent.length, 1, "model audio reaches the phone");
  s.params.audioSink.clearAudio("barge-in");
  assert.equal(link.clears, 1, "barge-in clears otacon's queue");
});

test("outbound: no answer hangs up and reports, without a model session", async () => {
  const { m, link, sessions, reports } = setup();
  m.start();
  await settle();
  link.call("call.state", { id: "c1", state: "alerting" });
  mock.timers.tick(20_000);
  await settle();
  assert.equal(sessions.length, 0);
  assert.ok(link.types().includes("hangup"));
  assert.equal(reports[0].outcome, "no_answer");
  assert.ok(reports[0].log.some((e) => /no answer/.test(e.text)));
});

test("send_dtmf presses keys quietly and logs them", async () => {
  const { link, s, m } = await connected();
  const r = await s.tool("send_dtmf", { digits: "3" });
  assert.deepEqual(link.cmds.at(-1), { type: "dtmf", fields: { digits: "3" } });
  assert.equal(r.options?.suppressResponse, true, "the model doesn't talk after pressing");
  assert.ok(m.report().log.some((e) => e.text === "pressed 3"));
});

test("end_call waits for the goodbye to play, hangs up, reports the note", async () => {
  const { link, s, reports } = await connected();
  s.transcript("user", "You're all set for Thursday.");
  s.transcript("assistant", "Thanks, bye!");
  await s.tool("end_call", { outcome: "done", summary: "Moved to Thursday 2 PM" });
  await settle();
  assert.ok(link.markCount >= 1, "waited for playback");
  assert.deepEqual(link.cmds.at(-1), { type: "hangup", fields: { call: "c1" } });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, "completed");
  assert.equal(reports[0].summary, "Moved to Thursday 2 PM");
  const said = reports[0].log.filter((e) => e.kind !== "event").map((e) => `${e.who}: ${e.text}`);
  assert.deepEqual(said, ["Bright Smile Dental: You're all set for Thursday.", "assistant: Thanks, bye!"]);
});

test("the other side hanging up ends the mission", async () => {
  const { link, reports, s } = await connected();
  link.call("call.ended", { id: "c1" }, "remote");
  await settle();
  assert.equal(reports[0].outcome, "completed");
  assert.ok(s.closed);
  assert.ok(reports[0].log.some((e) => /hung up \(remote\)/.test(e.text)));
});

test("hold: the model hears nothing until someone speaks, then gets the pre-roll", async () => {
  const { link, s, detector } = await connected();
  await s.tool("wait_on_hold");
  const before = s.audioIn.length;
  detector.prob = 0;
  for (let i = 0; i < 50; i++) link.emit("audio", frame());
  assert.equal(s.audioIn.length, before, "hold audio never reaches the model");
  detector.prob = 0.9;
  for (let i = 0; i < 31; i++) link.emit("audio", frame());
  assert.ok(s.audioIn.length > before, "woken with pre-roll");
  const after = s.audioIn.length;
  link.emit("audio", frame());
  assert.equal(s.audioIn.length, after + 1, "listening live again");
});

test("hold cap: hangs up and reports after holdCapSeconds", async () => {
  const { link, s, reports } = await connected();
  await s.tool("wait_on_hold");
  mock.timers.tick(59_000);
  await settle();
  assert.equal(reports.length, 0);
  mock.timers.tick(1_000);
  await settle();
  assert.equal(reports[0].outcome, "hold_cap");
  assert.ok(link.types().includes("hangup"));
});

test("30 s without speech enters hold by itself", async () => {
  const { link, s, detector } = await connected();
  detector.prob = 0;
  mock.timers.tick(31_000);
  link.emit("audio", frame());
  const n = s.audioIn.length;
  link.emit("audio", frame());
  assert.equal(s.audioIn.length, n, "music no longer reaches the model");
});

test("consult asks the agent with the call so far and logs both", async () => {
  const { s, consults, m } = await connected();
  s.transcript("user", "What time works for Nick?");
  const r = await s.tool("openclaw_agent_consult", { question: "What time works?" });
  assert.deepEqual(r.result, { text: "Nick prefers 7:30." });
  assert.equal(consults[0].sessionKey, `agent:main:voice:otacon:${m.id}`);
  assert.equal(consults[0].spawnedBy, "agent:main:main");
  assert.deepEqual(consults[0].transcript, [{ role: "user", text: "What time works for Nick?" }]);
  assert.ok(m.report().log.some((e) => /the agent answered: Nick prefers 7:30/.test(e.text)));
});

test("hand-off: hold, call the person, announce, merge after the announcement, leave", async () => {
  const { link, s, reports } = await connected({ contacts: [NICK] });
  assert.ok(s.params.tools.some((t: any) => t.name === "call_party"));

  const pending = s.tool("call_party", { contact: "nick", reason: "they need Nick" });
  await settle();
  assert.deepEqual(link.types().slice(-2), ["hold", "dial"]);
  link.call("call.state", { id: "c1", state: "held" });
  link.call("call.state", { id: "c2", state: "active" });
  const r = await pending;
  assert.equal(r.result.status, "connected");

  const c = await s.tool("connect_lines");
  assert.equal(c.result.status, "announce");
  assert.equal(link.types().at(-1), "swap", "back to the business to announce");
  // The announcement finishes playing: then merge and leave.
  s.params.onResponseDone({ status: "completed" });
  await settle();
  assert.equal(link.types().at(-1), "merge");
  assert.equal(reports[0].outcome, "handed_off");
  assert.ok(s.closed);
  // One party leaves the merged call: the host hangs up the other.
  link.call("call.state", { id: "c1", state: "active", conference: true });
  link.call("call.state", { id: "c2", state: "active", conference: false });
  link.call("call.ended", { id: "c1" }, "remote");
  await settle();
  assert.deepEqual(link.cmds.at(-1), { type: "hangup", fields: { call: "c2" } });
});

test("hand-off: the person doesn't answer, so back to the first party", async () => {
  const { link, s } = await connected({ contacts: [NICK] });
  const pending = s.tool("call_party", { contact: "nick" });
  await settle();
  link.call("call.state", { id: "c2", state: "alerting" });
  mock.timers.tick(20_000);
  const r = await pending;
  assert.equal(r.result.status, "no_answer");
  assert.deepEqual(link.types().slice(-2), ["hangup", "resume"]);
});

test("call_party only calls allowed contacts", async () => {
  const { link, s } = await connected({ contacts: [NICK] });
  const r = await s.tool("call_party", { contact: "someone-else" });
  assert.match(r.result.error, /not an allowed contact/);
  assert.ok(!link.types().includes("hold"));
});

test("inbound: answers the ringing call and greets first", async () => {
  const { m, link, sessions } = setup({ direction: "inbound" });
  m.start();
  await settle();
  assert.deepEqual(link.cmds[0], { type: "answer", fields: { call: "in1" } });
  assert.equal(sessions.length, 1);
  assert.match(sessions[0].userMessages[0], /Greet the caller/);
});
