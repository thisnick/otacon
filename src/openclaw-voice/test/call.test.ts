import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { CallMission, type MissionReport } from "../src/call.js";
import type { Contact } from "../src/config.js";
import { config, fakeWorkspace, FakeDecisions, FakeDetector, FakeLink, FakeTranscriber, fakeApi, fakeSdk, frame, settle } from "./fakes.js";

const BIZ = "+15555550100";
const NICK: Contact = { id: "nick", name: "Nick", number: "+15555550101" };

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] }));
afterEach(() => mock.timers.reset());

function setup(o: { direction?: "outbound" | "inbound"; contacts?: Contact[]; cfg?: Record<string, unknown>; menu?: boolean; holdLimitSeconds?: number } = {}) {
  const link = new FakeLink();
  const decisions = new FakeDecisions();
  const transcriber = new FakeTranscriber();
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
    line: { id: "sim" },
    sdk,
    detector,
    direction: o.direction ?? "outbound",
    party: { name: "Bright Smile Dental", number: BIZ, role: "primary" },
    inboundCallId: o.direction === "inbound" ? "in1" : undefined,
    brief: "Move the cleaning to Thursday 2 PM",
    contacts: o.contacts ?? [],
    agentId: "main",
    requesterSessionKey: "agent:main:main",
    menu: o.menu ? { decisions, openTranscriber: transcriber.open } : undefined,
    holdLimitSeconds: o.holdLimitSeconds,
    onEnd: (r) => reports.push(r),
  });
  return { m, link, sessions, consults, detector, reports, decisions, transcriber };
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
    ["send_dtmf", "end_call", "openclaw_agent_consult"],
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
  const ended = s.tool("end_call", { outcome: "done", summary: "Moved to Thursday 2 PM" });
  await settle();
  assert.match(s.notes.at(-1)!, /The call has ended/, "told the call is over, then given time for its last transcript");
  mock.timers.tick(10_000);
  await ended;
  await settle();
  assert.ok(link.markCount >= 1, "waited for playback");
  assert.deepEqual(link.cmds.at(-1), { type: "hangup", fields: { call: "c1" } });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, "completed");
  assert.equal(reports[0].summary, "Moved to Thursday 2 PM");
  const said = reports[0].log.filter((e) => e.kind !== "event").map((e) => `${e.who}: ${e.text}`);
  assert.deepEqual(said, ["Bright Smile Dental: You're all set for Thursday.", "assistant: Thanks, bye!"]);
});

test("the other side hanging up ends the mission, with what it said last", async () => {
  const { link, reports, s } = await connected();
  link.call("call.ended", { id: "c1" }, "remote");
  await settle();
  assert.equal(reports.length, 0, "waits for the last words");
  assert.equal(s.audioIn.at(-1)!.length, 16000 * 2, "a second of silence ends the voice model's turn");
  s.transcript("assistant", "Goodbye!"); // its reply to the silence, never played
  s.transcript("user", "Great, you're all set. Goodbye!");
  await settle();
  assert.equal(reports[0].outcome, "completed");
  assert.ok(s.closed);
  assert.ok(reports[0].log.some((e) => /hung up \(remote\)/.test(e.text)));
  const said = reports[0].log.filter((e) => e.kind !== "event").map((e) => `${e.who}: ${e.text}`);
  assert.deepEqual(said, ["Bright Smile Dental: Great, you're all set. Goodbye!"]);
  assert.match(reports[0].log.at(-1)!.text, /hung up \(remote\)/, "the hang-up is logged after the last words");
});

test("the other side hanging up with nothing left to say: reported after a short wait", async () => {
  const { link, reports } = await connected();
  link.call("call.ended", { id: "c1" }, "remote");
  await settle();
  mock.timers.tick(9_000);
  await settle();
  assert.equal(reports.length, 0, "up to 10 s for the last transcript");
  mock.timers.tick(1_000);
  await settle();
  assert.equal(reports[0].outcome, "completed");
});

test("hold: the model hears the line throughout, hold music included, and is told only to say it'll hold", async () => {
  const { link, s, detector, reports } = await connected();
  assert.match(s.params.instructions, /If someone asks you to hold, say "Sure, I'll hold\." once/);
  detector.prob = 0;
  for (let i = 0; i < 50; i++) link.emit("audio", frame());
  assert.equal(s.audioIn.length, 50, "hold music reaches the model");
  assert.equal(detector.windows, 0, "without the navigator, no speech detection");
  mock.timers.tick(600_000);
  await settle();
  assert.equal(reports.length, 0, "no hold limit without the navigator");
});

test("consult asks the agent with the call so far and logs both", async () => {
  const { s, consults, m } = await connected();
  s.transcript("user", "What time works for Nick?");
  const r = await s.tool("openclaw_agent_consult", { question: "What time works?" });
  assert.deepEqual(r.result, { text: "Nick prefers 7:30." });
  // Per phone by default: every call with this number shares one session.
  assert.equal(consults[0].sessionKey, "agent:main:voice:15555550100");
  assert.equal(m.report().sessionKey, "agent:main:voice:15555550100");
  assert.equal(consults[0].spawnedBy, "agent:main:main");
  assert.deepEqual(consults[0].transcript, [{ role: "user", text: "What time works for Nick?" }]);
  assert.ok(m.report().log.some((e) => /the agent answered: Nick prefers 7:30/.test(e.text)));
});

test("consult uses the configured thinking level and fast mode", async () => {
  const { s, consults } = await connected({ cfg: { consultThinkingLevel: "low", consultFastMode: true } });
  await s.tool("openclaw_agent_consult", { question: "What time works?" });
  assert.equal(consults[0].thinkLevel, "low");
  assert.equal(consults[0].fastMode, true);
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

test("inbound: answers the ringing call and greets first, with the configured greeting", async () => {
  const { m, link, sessions } = setup({ direction: "inbound", cfg: { inboundGreeting: "I'm the bot, how can I help?" } });
  m.start();
  await settle();
  assert.deepEqual(link.cmds[0], { type: "answer", fields: { call: "in1" } });
  assert.equal(sessions.length, 1);
  assert.match(sessions[0].userMessages[0], /Include this greeting in your first spoken reply: "I'm the bot, how can I help\?"/);
  assert.doesNotMatch(sessions[0].userMessages[0], /my principal|an AI assistant/, "no owner or assistant name added");
  await m.finish("completed");

  const quiet = setup({ direction: "inbound", cfg: { inboundGreeting: "" } });
  quiet.m.start();
  await settle();
  assert.equal(quiet.sessions[0].userMessages.length, 0, "no greeting: it waits for the caller");
  await quiet.m.finish("completed");
});

// ---- phone-menu navigator ----

/** Let the navigator take its next look at the call. */
async function navigatorCheck() {
  mock.timers.tick(3000);
  await settle();
}

test("navigator: hears the line, presses menu options and tells the voice model, and sees the voice model's presses", async () => {
  const { m, s, link, decisions, transcriber } = await connected({ menu: true });
  assert.match(s.params.instructions, /phone-menu navigator is also listening/);
  link.emit("audio", frame());
  assert.equal(transcriber.audio.length, 1, "the line reaches the live transcriber");
  assert.equal(s.audioIn.length, 1, "and still reaches the voice model");

  decisions.answer = { action: "press", key: "3" };
  transcriber.say("To make a reservation, press three. ");
  await navigatorCheck();
  assert.deepEqual(link.cmds.at(-1), { type: "dtmf", fields: { digits: "3" } });
  assert.equal(s.bridgeEvents.at(-1).type, "conversation.item.create");
  assert.equal(s.bridgeEvents.at(-1).item.role, "system");
  assert.match(s.notes.at(-1)!, /navigator pressed 3 on your behalf/);
  assert.equal(s.userMessages.length, 0, "notes don't ask the voice model to reply");

  // The menu asks for information: that's the voice model's.
  decisions.answer = { action: "wait" };
  transcriber.say("Please enter your phone number. ");
  await s.tool("send_dtmf", { digits: "5551234" });
  await navigatorCheck();
  assert.deepEqual(
    decisions.states.at(-1).transcript.filter((e: any) => e.who === "keypad").map((e: any) => e.text),
    ["pressed 3 (you)", "pressed 5551234 (the assistant)"],
  );
  assert.ok(m.report().log.some((e) => e.text === "the navigator pressed 3"));
  await m.finish("completed");
  assert.equal(transcriber.closed, true);
});

test("navigator: hands off when a person speaks; the voice model has the call from then on", async () => {
  const { m, s, link, decisions, transcriber } = await connected({ menu: true });
  decisions.answer = { action: "hand_off" };
  transcriber.say("Hi, this is Marco at Luigi's. How can I help? ");
  s.transcript("assistant", "Hi Marco, I'd like a table for two.");
  await navigatorCheck();
  assert.equal(transcriber.closed, true, "the live transcript stops");
  assert.match(s.notes.at(-1)!, /a person is on the line\. The call is yours/);
  assert.equal(decisions.states[0].transcript.at(-1).who, "assistant");

  const checks = decisions.states.length;
  transcriber.say("Sure, what time? ");
  link.emit("audio", frame());
  await navigatorCheck();
  assert.equal(decisions.states.length, checks, "no more checks after the hand-off");
  await m.finish("completed");
});

test("navigator: hangs up when the goal is done, and reports why", async () => {
  const { s, decisions, transcriber, reports } = await connected({ menu: true });
  decisions.answer = { action: "hang_up", p: 0.97, reason: "goal_done" };
  transcriber.say("We are at 1 2 3 Main Street in Oakland. ");
  await navigatorCheck();
  await settle();
  // We hung up mid-recording: the voice model still transcribes it.
  assert.equal(reports.length, 0);
  s.transcript("user", "We are at 1 2 3 Main Street in Oakland.");
  await settle();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].log.some((e) => e.kind === "hear" && /1 2 3 Main Street/.test(e.text)));
  assert.equal(reports[0].outcome, "completed");
  assert.match(reports[0].summary!, /navigator hung up: what the line said achieved the goal/);
  assert.equal(s.closed, true);
});

test("navigator: hears hold music too, and hangs up past the hold limit", async () => {
  const { s, link, detector, decisions, transcriber, reports } = await connected({ menu: true });
  assert.equal(detector.resets, 1, "a fresh detector for the call");
  detector.prob = 0;
  // 6 s of hold music and nothing said: the navigator still looks.
  for (let i = 0; i < 31 * 6; i++) link.emit("audio", frame());
  assert.equal(transcriber.audio.length, 31 * 6, "hold music is transcribed");
  decisions.answer = { action: "hang_up", p: 0.95, reason: "hold_limit" };
  await navigatorCheck();
  await settle();
  mock.timers.tick(10_000);
  await settle();
  const st = decisions.states.at(-1);
  assert.equal(st.line_audio.now, "music");
  assert.equal(st.line_audio.seconds_on_hold, 6);
  assert.equal(st.hold_limit_seconds, 60);
  assert.equal(reports[0].outcome, "hold_cap");
  assert.match(reports[0].summary!, /on hold for longer than 1 min/);
  assert.ok(link.types().includes("hangup"));
});

test("navigator: whoever places the call can set its hold limit", async () => {
  const { m, decisions, transcriber } = await connected({ menu: true, holdLimitSeconds: 900 });
  transcriber.say("Please hold. ");
  await navigatorCheck();
  assert.equal(decisions.states.at(-1).hold_limit_seconds, 900);
  await m.finish("completed");
});

test("navigator: 10 s of music stops the line reaching the voice model until someone speaks, then it gets the last 2 s", async () => {
  const { m, s, link, detector, transcriber } = await connected({ menu: true });
  detector.prob = 0;
  for (let i = 0; i < 31 * 10; i++) link.emit("audio", frame());
  assert.equal(s.audioIn.length, 31 * 10, "the first 10 s reach it");
  for (let i = 0; i < 31 * 5; i++) link.emit("audio", frame());
  assert.equal(s.audioIn.length, 31 * 10, "then the music doesn't");
  assert.equal(transcriber.audio.length, 31 * 15, "the navigator still hears it all");
  detector.prob = 0.9;
  for (let i = 0; i < 31; i++) link.emit("audio", frame());
  // 2 s of 32 ms frames: the latest 62 (the second of speech among them)
  assert.equal(s.audioIn.length, 31 * 10 + 62, "speech: the last 2 s, then live");
  link.emit("audio", frame());
  assert.equal(s.audioIn.length, 31 * 10 + 63);
  await m.finish("completed");
});

test("navigator: after the hand-off, no muting and no more speech detection", async () => {
  const { m, s, link, detector, decisions, transcriber } = await connected({ menu: true });
  decisions.answer = { action: "hand_off" };
  transcriber.say("Hi, this is Marco. ");
  await navigatorCheck();
  const n = detector.windows;
  const heard = s.audioIn.length;
  detector.prob = 0;
  for (let i = 0; i < 31 * 12; i++) link.emit("audio", frame());
  assert.equal(detector.windows, n);
  assert.equal(s.audioIn.length, heard + 31 * 12, "hold music after the hand-off reaches the voice model");
  await m.finish("completed");
});

test("navigator: never on incoming calls", async () => {
  const { m, transcriber, sessions } = setup({ direction: "inbound", menu: true });
  m.start();
  await settle();
  assert.equal(sessions.length, 1);
  assert.equal(transcriber.handlers, undefined);
  assert.doesNotMatch(sessions[0].params.instructions, /phone-menu navigator/);
  await m.finish("completed");
});

test("consults get a working result first: the answer is coming, nothing to say unless they talk", async () => {
  const { s, m } = await connected();
  await s.tool("openclaw_agent_consult", { question: "What time works?" });
  const [working, final] = s.toolResults.slice(-2);
  assert.equal(working.options?.willContinue, true);
  assert.equal(working.result.status, "working");
  assert.match(working.result.message, /If they talk before it arrives, tell them briefly you're still checking/);
  assert.doesNotMatch(working.result.message, /Checking\./);
  assert.deepEqual(final.result, { text: "Nick prefers 7:30." });
  await m.finish("completed");

  const plain = await connected();
  plain.s.continuation = false; // a bridge without interim results
  await plain.s.tool("openclaw_agent_consult", { question: "What time works?" });
  assert.equal(plain.s.toolResults.length, 1, "only the answer");
  await plain.m.finish("completed");
});

test("agent context: the agent's identity and workspace files reach the voice model, when enabled", async () => {
  fakeWorkspace.identity = { name: "Eta" };
  fakeWorkspace.files = { "USER.md": "Nick Yu. Phone: <owner number>." };
  const on = await connected({ cfg: { realtime: { agentContext: { enabled: true } } } });
  assert.match(on.s.params.instructions, /OpenClaw agent voice context:/);
  assert.match(on.s.params.instructions, /### USER\.md\nNick Yu/);
  await on.m.finish("completed");

  const off = await connected();
  assert.doesNotMatch(off.s.params.instructions, /agent voice context/);
  await off.m.finish("completed");
});

test("listen-in: a listener hears both sides, paced by the line; leaving doesn't end the call; the call's end hangs them up", async () => {
  const { m, s, link, reports } = await connected();
  const sent: Buffer[] = [];
  let hungUp = 0;
  let end: ((r: string) => void) | undefined;
  m.addListener("Nick", { id: "L1", send: (b) => void sent.push(b), hangUp: async () => void (hungUp++, end?.("local")), onEnd: (fn) => void (end = fn) });
  s.speak(Buffer.alloc(960)); // the voice model talks (24 kHz -> 16 kHz)
  link.emit("audio", frame());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, frame().length, "one line chunk, mixed");
  assert.match(m.report().log.at(-1)!.text, /Nick started listening/);
  assert.deepEqual(m.status.listening, ["Nick"]);
  end!("remote"); // they hang up the listening call
  link.emit("audio", frame());
  assert.equal(sent.length, 1);
  assert.equal(reports.length, 0, "the call carries on");
  assert.match(m.report().log.at(-1)!.text, /Nick stopped listening/);

  m.addListener("Nick", { id: "L2", send: () => {}, hangUp: async () => void hungUp++, onEnd: () => {} });
  await m.finish("completed");
  assert.equal(hungUp, 1, "the call's end hangs up the listening call");
});
