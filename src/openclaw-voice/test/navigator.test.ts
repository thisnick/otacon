import assert from "node:assert/strict";
import { test } from "node:test";
import { MenuNavigator, openRouterDecisions, QUESTIONS } from "../src/navigator.js";
import { FakeDecisions } from "./fakes.js";

function nav(answer: FakeDecisions["answer"]) {
  const decisions = new FakeDecisions();
  decisions.answer = answer;
  const acts: string[] = [];
  const n = new MenuNavigator({
    goal: "Book a table for 2 at 7:30",
    checkEverySeconds: 3,
    threshold: 0.6,
    client: decisions,
    now: () => 0,
    press: async (k) => void acts.push(`press ${k}`),
    hangUp: (r) => void acts.push(`hang up ${r}`),
    handOff: () => void acts.push("hand off"),
    log: () => {},
  });
  return { n, decisions, acts };
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
  assert.deepEqual(
    decisions.states[1].keys_pressed.map((k: any) => `${k.by}:${k.keys}`),
    ["navigator:3"],
  );
  assert.deepEqual(acts, ["press 3"]);
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

test("hangs up from the threshold, and never while on hold", async () => {
  const below = nav({ action: "hang_up", p: 0.55 });
  below.n.lineText("We are closed. ");
  await below.n.check();
  assert.deepEqual(below.acts, []);

  const onHold = nav({ action: "hang_up", p: 0.97 });
  onHold.n.hold(true);
  onHold.n.lineText("Your call is important to us. ");
  await onHold.n.check();
  assert.deepEqual(onHold.acts, []);

  const closed = nav({ action: "hang_up", p: 0.97, reason: "no_way" });
  closed.n.lineText("We are closed. Goodbye. ");
  await closed.n.check();
  assert.deepEqual(closed.acts, ["hang up no_way"]);
});

test("each check sees both sides in order, every key press, and the hold", async () => {
  const { n, decisions } = nav({ action: "wait" });
  n.lineText("Thanks for calling Luigi's. For ");
  n.lineText("prices, press 2");
  n.assistantSaid("Hi, I'd like a table.");
  n.pressed("assistant", "1");
  n.hold(true);
  await n.check();
  const st = decisions.states[0];
  assert.equal(st.goal, "Book a table for 2 at 7:30");
  assert.deepEqual(
    st.transcript.map((e: any) => `${e.who}: ${e.text}`),
    ["line: Thanks for calling Luigi's.", "line: For prices, press 2", "assistant: Hi, I'd like a table."],
  );
  assert.deepEqual(st.keys_pressed.map((k: any) => `${k.by}:${k.keys}`), ["assistant:1"]);
  assert.equal(st.on_hold, true);
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

  const failing = openRouterDecisions({
    apiKey: "k",
    model: "m",
    fetchImpl: (async () => new Response(JSON.stringify({ error: { message: "no such model" } }), { status: 400 })) as any,
  });
  await assert.rejects(failing.decide({}, QUESTIONS), /decisions api: no such model/);
});
