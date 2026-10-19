// Offline check of the phone-menu navigator: runs the plugin's own
// navigator (build the plugin first) against scripted calls on a simulated
// clock, with the real decision model, and prints each decision and what the
// navigator did. Steps: a line sentence (3 s of speech), ["assistant", text],
// { music: s } or { silence: s } (checked as the navigator would: when it
// starts and every 15 s), { press: keys } (a press from an earlier menu).
//
//   OPENROUTER_API_KEY=$(python3 tests/voice/fleet.py secret OPENROUTER_API_KEY) \
//     node tests/voice/navigator_eval.mjs [scenario]
import { MenuNavigator, openRouterDecisions } from "../../src/openclaw-voice/dist/navigator.js";

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
    steps: ["Thanks for calling Luigi's Trattoria, serving Oakland since 1987.", ...LUIGIS_OPTIONS, ...LUIGIS_OPTIONS],
  },
  // Press 3, wait through the hold (music and an announcement), then hand
  // off to the assistant when Marco speaks.
  hold: {
    goal: "Book a table for 2 people tonight at 7:30 PM under the name Nick.",
    steps: [
      "Thanks for calling Luigi's Trattoria.",
      "To make a reservation, press 3.",
      "Please hold while I connect you to our host.",
      { music: 40 },
      "Thank you for holding. Your call is important to us. Please stay on the line.",
      { music: 20 },
      "Hi, this is Marco at Luigi's. Sorry about the wait! How many people, and what time?",
    ],
  },
  // On hold past the limit (120 s here): hang up, and not before.
  longhold: {
    goal: "Ask Bright Smile Dental to move Nick's cleaning to Thursday at 2 PM.",
    limit: 120,
    steps: [
      "Thank you for calling Bright Smile Dental. All of our staff are helping other patients.",
      "Please stay on the line and your call will be answered in the order it was received.",
      { music: 60 },
      "Thank you for your patience. Your call is important to us.",
      { music: 90 },
    ],
  },
  // Nothing at all on the line past the limit: hang up, and not before.
  silence: {
    goal: "Ask whether Nick's prescription is ready for pickup.",
    limit: 120,
    steps: [{ silence: 150 }],
  },
  // No option fits, but the brief allows a person, and giving up after a
  // couple of loops (the MoMA call, 2026-10-18): the navigator must not
  // wait forever.
  deadend: {
    goal: "Find MoMA's street address using the phone menu. Press the address, hours or visitor-info option as soon as you hear it, then hang up once you have the address. If there's no such option you may ask a live person. If the menu loops a couple of times without it, hang up.",
    steps: [...Array(3)].flatMap(() => MOMA),
  },
  // A recorded welcome that sounds like a person: not a hand-off.
  welcome: {
    goal: "Ask Bright Smile Dental to move Nick's cleaning to Thursday at 2 PM.",
    steps: [
      "Welcome to Bright Smile Dental, where we care about your smile.",
      "Our office is open Monday through Friday, 8 AM to 5 PM.",
      "If you're calling about an appointment, please stay on the line.",
    ],
  },
  // Someone picks up and just says hello: hand off.
  hello: {
    goal: "Ask whether Nick's prescription is ready for pickup.",
    steps: ["Hello?", { silence: 3 }],
  },
  // A person answers: hand off at once.
  person: {
    goal: "Ask whether Nick's prescription is ready for pickup.",
    steps: ["Corner Pharmacy, how can I help you?"],
  },
  // Information to type in is the assistant's: wait.
  input: {
    goal: "Check the balance on Nick's account.",
    steps: [{ press: "2" }, "Please enter your 10-digit account number, followed by the pound key."],
  },
  // The goal is met by the recording: hang up.
  done: {
    goal: "Find the museum's street address. Use the phone menu; don't wait for a person.",
    steps: [{ press: "2" }, "The Metropolitan Museum of Art is located at 1000 Fifth Avenue, at 82nd Street, in New York City.", "To return to the main menu, press star."],
  },
};

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY is not set");
const decisions = openRouterDecisions({ apiKey: key, model: process.env.MODEL ?? "openai/gpt-6-luna-decisions" });
const p = (a, q, c) => (a[q]?.probabilities?.[c] ?? 0).toFixed(2);
const T = Number(process.env.THRESHOLD ?? 0.6);

for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (process.argv[2] && process.argv[2] !== name) continue;
  console.log(`\n== ${name}${sc.limit ? ` (hold limit ${sc.limit} s)` : ""}: ${sc.goal}`);
  let ms = 0;
  let label = "";
  const did = (what) => console.log(`        => ${what}`);
  const nav = new MenuNavigator({
    goal: sc.goal,
    checkEverySeconds: 3,
    holdLimitSeconds: sc.limit ?? 300,
    threshold: T,
    client: {
      async decide(state, questions) {
        const a = await decisions.decide(state, questions);
        const act = a.action.choice;
        const audio = state.line_audio ? `[${state.line_audio.now} ${state.line_audio.for_seconds}s, hold ${state.line_audio.seconds_on_hold}s]` : "";
        const why = act === "hang_up" ? `  why: goal_done ${p(a, "hang_up_reason", "goal_done")}, no_way ${p(a, "hang_up_reason", "no_way")}, hold_limit ${p(a, "hang_up_reason", "hold_limit")}` : "";
        console.log(`  ${String(Math.round(ms / 1000)).padStart(4)}s ${label.slice(0, 50).padEnd(50)} ${audio.padEnd(26)} -> ${act} ${p(a, "action", act)}  key ${a.key.choice} ${p(a, "key", a.key.choice)}  (press ${p(a, "action", "press")}, hand_off ${p(a, "action", "hand_off")}, hang_up ${p(a, "action", "hang_up")})${why}`);
        return a;
      },
    },
    now: () => ms,
    press: async (k) => (did(`PRESS ${k}`), true),
    hangUp: (r) => did(`HANG UP (${r})`),
    handOff: () => did("HAND OFF"),
    log: () => {},
  });
  // Seconds of one sound; the navigator looks every 3 s, as in a call.
  const play = async (sound, seconds) => {
    for (let s = 1; s <= seconds && !nav.stopped; s++) {
      for (let i = 0; i < 31; i++) nav.lineSound(sound === "speech" ? 0.9 : 0.02, sound === "silence" ? 0.0005 : 0.05);
      ms += 1000;
      if ((ms / 1000) % 3 === 0) await nav.check();
    }
  };
  for (const step of sc.steps) {
    if (nav.stopped) break;
    if (typeof step === "string") {
      label = step;
      await play("speech", 2);
      nav.lineText(step + " ");
      await play("speech", 1);
    } else if (Array.isArray(step)) {
      label = `(assistant) ${step[1]}`;
      nav.assistantSaid(step[1]);
      await play("silence", 3);
    } else if (step.press) {
      nav.pressed("navigator", step.press);
    } else {
      const [sound, seconds] = Object.entries(step)[0];
      label = `(${sound})`;
      await play(sound, seconds);
    }
  }
}
