// Offline check of the phone-menu navigator's questions: feeds the decision
// model scripted call transcripts one sentence at a time, with the plugin's
// own questions (build the plugin first), and prints each decision.
//
//   OPENROUTER_API_KEY=$(python3 tests/voice/fleet.py secret OPENROUTER_API_KEY) \
//     node tests/voice/navigator_eval.mjs [scenario]
import { openRouterDecisions, QUESTIONS } from "../../src/openclaw-voice/dist/navigator.js";

const LUIGIS_OPTIONS = [
  "For our location and hours, press 1.",
  "For prices and today's specials, press 2.",
  "To make a reservation, press 3.",
  "For catering and private events, press 4.",
  "For gift cards, press 5.",
  "To hear these options again, press 9.",
];

const MOMA = [
  "Thank you for calling The Museum of Modern Art.",
  "MoMA is open daily from 10:30 a.m. to 5:30 p.m., and until 7 p.m. on Saturdays.",
  "Tickets can be purchased online at moma.org.",
  "For the MoMA Design Store, press 1. For membership, press 2. For MoMA PS1, press 3.",
  "To speak with an operator, press 0. To repeat this message, press pound.",
];

const SCENARIOS = {
  // Should press 3 right after hearing it, not wait for the menu to end.
  menu: {
    goal: "Book a table for 2 people tonight at 7:30 PM under the name Nick. Their phone menu has a reservations option.",
    lines: ["Thanks for calling Luigi's Trattoria, serving Oakland since 1987.", ...LUIGIS_OPTIONS, ...LUIGIS_OPTIONS],
  },
  // Should wait on hold, then hand off to the assistant when Marco speaks.
  hold: {
    goal: "Book a table for 2 people tonight at 7:30 PM under the name Nick.",
    pressed: [{ t: 16, by: "navigator", keys: "3" }],
    lines: [
      "Please hold while I connect you to our host.",
      "Hi, this is Marco at Luigi's. How many people, and what time would you like?",
      ["assistant", "Hi Marco, a table for two tonight at 7:30, please, under Nick."],
      "Sure, let me check. Yes, 7:30 works.",
    ],
  },
  // No option fits, but the brief allows a person, and giving up after a
  // couple of loops (the MoMA call, 2026-10-18): the navigator must not
  // wait forever.
  deadend: {
    goal: "Find MoMA's street address using the phone menu. Press the address, hours or visitor-info option as soon as you hear it, then hang up once you have the address. If there's no such option you may ask a live person. If the menu loops a couple of times without it, hang up.",
    lines: [...Array(3)].flatMap(() => MOMA),
  },
  // A person answers: hand off at once.
  person: {
    goal: "Ask whether Nick's prescription is ready for pickup.",
    lines: ["Corner Pharmacy, how can I help you?"],
  },
  // Information to type in is the assistant's: wait.
  input: {
    goal: "Check the balance on Nick's account.",
    pressed: [{ t: 8, by: "navigator", keys: "2" }],
    lines: ["Please enter your 10-digit account number, followed by the pound key."],
  },
  // The goal is met by the recording: hang up.
  done: {
    goal: "Find the museum's street address. Use the phone menu; don't wait for a person.",
    pressed: [{ t: 9, by: "navigator", keys: "2" }],
    lines: ["The Metropolitan Museum of Art is located at 1000 Fifth Avenue, at 82nd Street, in New York City.", "To return to the main menu, press star."],
  },
};

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY is not set");
const client = openRouterDecisions({ apiKey: key, model: process.env.MODEL ?? "openai/gpt-6-luna-decisions" });
const p = (a, q, c) => (a[q]?.probabilities?.[c] ?? 0).toFixed(2);
// What the navigator would do with these answers (navigator.ts check()).
const T = Number(process.env.THRESHOLD ?? 0.6);
const would = (a) => {
  const act = a.action.choice, pa = a.action.probabilities[act] ?? 0;
  if (pa < T) return "";
  if (act === "press") return (a.key.probabilities[a.key.choice] ?? 0) >= T && a.key.choice !== "none" ? `=> PRESS ${a.key.choice}` : "";
  return act === "wait" ? "" : `=> ${act.toUpperCase()}`;
};

for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (process.argv[2] && process.argv[2] !== name) continue;
  console.log(`\n== ${name}: ${sc.goal}`);
  const transcript = [];
  for (const [i, line] of sc.lines.entries()) {
    const [who, text] = Array.isArray(line) ? line : ["line", line];
    transcript.push({ t: 2 + i * 2.4, who, text });
    const state = { goal: sc.goal, seconds_into_call: 2 + i * 2.4, on_hold: false, seconds_on_hold: 0, transcript, keys_pressed: sc.pressed ?? [] };
    const a = await client.decide(state, QUESTIONS);
    const act = a.action.choice;
    console.log(`  ${(who === "assistant" ? "(assistant) " : "") + text.slice(0, 60).padEnd(60)} -> ${act} ${p(a, "action", act)}  key ${a.key.choice} ${p(a, "key", a.key.choice)}  (press ${p(a, "action", "press")}, hand_off ${p(a, "action", "hand_off")}, hang_up ${p(a, "action", "hang_up")}) ${would(a)}`);
  }
}
