import assert from "node:assert/strict";
import { test } from "node:test";
import { MenuNavigator, openRouterDecisions, QUESTIONS } from "../src/navigator.js";
import { FakeDecisions } from "./fakes.js";

function nav(answer: FakeDecisions["answer"], clock = { ms: 0 }, pressWorks = () => true) {
  const decisions = new FakeDecisions();
  decisions.answer = answer;
  const acts: string[] = [];
  const n = new MenuNavigator({
    goal: "Book a table for 2 at 7:30",
    checkEverySeconds: 3,
    holdLimitSeconds: 300,
    threshold: 0.6,
    client: decisions,
    now: () => clock.ms,
    press: async (k) => {
      acts.push(`press ${k}`);
      return pressWorks();
    },
    hangUp: (r) => void acts.push(`hang up ${r}`),
    handOff: () => void acts.push("hand off"),
    log: () => {},
  });
  return { n, decisions, acts };
}

/** Seconds of one sound on the line, as the speech detector reports them. */
function play(n: MenuNavigator, sound: "speech" | "music" | "silence", seconds: number) {
  for (let i = 0; i < 31 * seconds; i++) n.lineSound(sound === "speech" ? 0.9 : 0.02, sound === "silence" ? 0.0005 : 0.05);
}

test("presses an offered option once, then waits for the line to answer", async () => {
  const { n, acts, decisions } = nav({ action: "press", key: "3" });
  n.lineText("For reservations, press three. ");
  await n.check();
  assert.deepEqual(acts, ["press 3"]);
  await n.check(); // nothing new from the line: no check
  assert.equal(decisions.states.length, 1);
  decisions.answer = { action: "wait" };
  n.lineText("Please hold while I connect you.");
  await n.check();
  assert.equal(decisions.states.length, 2);
  // The press is in the transcript, between the menu and what came after.
  assert.deepEqual(
    decisions.states[1].transcript.map((e: any) => `${e.who}: ${e.text}`),
    ["line: For reservations, press three.", "keypad: pressed 3 (you)", "line: Please hold while I connect you."],
  );
  assert.deepEqual(acts, ["press 3"]);
});

test("a failed press is forgotten and tried again at the next check", async () => {
  let works = false;
  const { n, acts, decisions } = nav({ action: "press", key: "3" }, { ms: 0 }, () => works);
  n.lineText("To make a reservation, press three. ");
  await n.check();
  works = true;
  await n.check(); // nothing new said, but the press failed
  assert.deepEqual(acts, ["press 3", "press 3"]);
  assert.ok(!decisions.states[1].transcript.some((e: any) => e.who === "keypad"), "the failed press isn't in the transcript");
});

test("below the threshold nothing is pressed", async () => {
  const { n, acts } = nav({ action: "press", key: "3", p: 0.55 });
  n.lineText("To make a reservation, press three. ");
  await n.check();
  assert.deepEqual(acts, []);
});

test("hands off once a person speaks, and stops for good", async () => {
  const { n, acts, decisions } = nav({ action: "hand_off" });
  n.lineText("Hi, this is Marco at Luigi's. How can I help? ");
  await n.check();
  assert.deepEqual(acts, ["hand off"]);
  assert.equal(n.stopped, true);
  n.lineText("Hello?");
  await n.check();
  assert.equal(decisions.states.length, 1);
});

test("hangs up from the threshold", async () => {
  const below = nav({ action: "hang_up", p: 0.55 });
  below.n.lineText("We are closed. ");
  await below.n.check();
  assert.deepEqual(below.acts, []);

  const closed = nav({ action: "hang_up", p: 0.97, reason: "no_way" });
  closed.n.lineText("We are closed. Goodbye. ");
  await closed.n.check();
  assert.deepEqual(closed.acts, ["hang up no_way"]);
});

test("each check sees both sides in order, every key press, and what the line plays", async () => {
  const { n, decisions } = nav({ action: "wait" });
  n.lineText("Thanks for calling Luigi's. For ");
  n.lineText("prices, press 2");
  n.assistantSaid("Hi, I'd like a table.");
  n.pressed("assistant", "1");
  play(n, "speech", 2);
  play(n, "music", 6);
  await n.check();
  const st = decisions.states[0];
  assert.equal(st.goal, "Book a table for 2 at 7:30");
  assert.deepEqual(
    st.transcript.map((e: any) => `${e.who}: ${e.text}`),
    ["line: Thanks for calling Luigi's.", "line: For prices, press 2", "assistant: Hi, I'd like a table.", "keypad: pressed 1 (the assistant)"],
  );
  assert.deepEqual(st.line_audio, {
    now: "music",
    for_seconds: 6,
    seconds_on_hold: 6,
    recent: [
      { sound: "speech", from: 0, to: 2 },
      { sound: "music", from: 2, to: 8 },
    ],
  });
  assert.equal(st.hold_limit_seconds, 300);
});

test("on hold it looks when the music starts and every 15 s, with nothing said, and hangs up past the limit", async () => {
  const clock = { ms: 0 };
  const { n, decisions, acts } = nav({ action: "wait" }, clock);
  play(n, "music", 4);
  await n.check();
  assert.equal(decisions.states.length, 0, "a short pause isn't a hold");
  play(n, "music", 2);
  await n.check();
  assert.equal(decisions.states.length, 1, "the hold began");
  clock.ms = 10_000;
  await n.check();
  assert.equal(decisions.states.length, 1);
  clock.ms = 15_000;
  await n.check();
  assert.equal(decisions.states.length, 2, "and again 15 s later");
  decisions.answer = { action: "hang_up", reason: "hold_limit" };
  clock.ms = 30_000;
  await n.check();
  assert.deepEqual(acts, ["hang up hold_limit"]);
});

test("a failed check is tried again at the next one", async () => {
  const { n, decisions } = nav({ action: "wait" });
  let fail = true;
  const decide = decisions.decide.bind(decisions);
  decisions.decide = async (s: unknown) => {
    if (fail) {
      fail = false;
      throw new Error("timeout");
    }
    return decide(s);
  };
  n.lineText("For prices, press 2. ");
  await n.check();
  await n.check(); // no new text, but the last check failed
  assert.equal(decisions.states.length, 1);
});

test("openRouterDecisions sends the model, the privacy setting, the state and the questions", async () => {
  let req: { url: string; init: any } | undefined;
  const client = openRouterDecisions({
    apiKey: "k",
    model: "openai/gpt-6-luna-decisions",
    fetchImpl: (async (url: string, init: any) => {
      req = { url, init };
      return new Response(JSON.stringify({ answers: { action: { choice: "wait", probabilities: { wait: 1 } } } }), { status: 200 });
    }) as any,
  });
  const a = await client.decide({ goal: "x" }, QUESTIONS);
  assert.equal(a.action.choice, "wait");
  assert.equal(req!.url, "https://openrouter.ai/api/v1/systemone");
  assert.equal(req!.init.headers.Authorization, "Bearer k");
  const body = JSON.parse(req!.init.body);
  assert.equal(body.model, "openai/gpt-6-luna-decisions");
  assert.deepEqual(body.provider, { data_collection: "deny" });
  assert.deepEqual(body.state, { goal: "x" });
  assert.deepEqual(Object.keys(body.questions), ["action", "key", "hang_up_reason"]);
  assert.deepEqual(Object.keys(body.questions.hang_up_reason.criteria), ["goal_done", "no_way", "hold_limit", "neither"]);

  const failing = openRouterDecisions({
    apiKey: "k",
    model: "m",
    fetchImpl: (async () => new Response(JSON.stringify({ error: { message: "no such model" } }), { status: 400 })) as any,
  });
  await assert.rejects(failing.decide({}, QUESTIONS), /decisions api: no such model/);
});
