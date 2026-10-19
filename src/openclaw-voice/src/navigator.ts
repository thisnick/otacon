// The phone-menu navigator. On a call an agent places, a decision model
// (OpenRouter's Decisions API) reads the live transcript of the line every
// few seconds, beside the voice model, with what the line plays (speech,
// music or silence, linesound.ts), and decides one of:
//   - press a menu option ("for directions, press 2")
//   - hang up: no person is on the line and the goal is done, or there's no
//     way to reach it (a loop with no fitting option, closed, not in service),
//     or the hold has run past its limit
//   - hand off: the line waits for a spoken answer (someone asks how they can
//     help, or just says hello). The navigator stops for the rest of the
//     call and the voice model carries on alone.
//   - wait
// It never speaks and never types in information (a phone number, a date of
// birth): that's the voice model's job, which keeps its keypad throughout.
// Each side sees the other's key presses: the navigator in its transcript,
// the voice model through notes (call.ts).

import { LineSound } from "./linesound.js";

export interface TranscriptEntry {
  /** Seconds since the call was answered */
  t: number;
  who: "line" | "assistant";
  text: string;
}

export interface KeyPress {
  t: number;
  by: "navigator" | "assistant";
  keys: string;
}

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
}

/** One Decisions API request: a state and named choice questions. */
export interface DecisionClient {
  decide(state: unknown, questions: Record<string, ChoiceQuestion>): Promise<Record<string, ChoiceAnswer>>;
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export const DECISIONS_URL = "https://openrouter.ai/api/v1/systemone";

export function openRouterDecisions(o: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): DecisionClient {
  const fetchImpl = o.fetchImpl ?? fetch;
  return {
    async decide(state, questions) {
      const res = await fetchImpl(DECISIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
        // Only providers that don't train on the data may answer.
        body: JSON.stringify({ model: o.model, provider: { data_collection: "deny" }, state, questions }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
      });
      const payload: any = await res.json().catch(() => null);
      if (!res.ok || !payload?.answers || payload.error) {
        throw new Error(`decisions api: ${String(payload?.error?.message ?? payload?.error ?? `HTTP ${res.status}`).slice(0, 200)}`);
      }
      return payload.answers;
    },
  };
}

const KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#"];

export const QUESTIONS: Record<string, ChoiceQuestion> = {
  action: {
    type: "choice",
    instructions:
      "You navigate automated phone menus for an assistant making this call; the assistant talks to people and types in or says any information. line_audio is what the line has been playing: speech (a person or a recording), music, or silence; seconds_on_hold counts from when it went to music or silence after the last key press. Act as soon as you can. What should you do right now?",
    criteria: {
      wait: "Nothing to do now: no option that fits the goal has been offered yet; or the key for the fitting option was already pressed and the line hasn't answered it yet; or the line has only greeted, welcomed or given information so far; or the call is on hold (hold music, silence, or a recorded hold message) for no longer than hold_limit_seconds; or the line asks for information to be typed in (the assistant does that).",
      press: "An automated menu has offered an option that fits the goal, and its key hasn't been pressed yet. Press it right away, without waiting for the rest of the menu.",
      hand_off: "The line is waiting for the assistant to speak: it asks a question or wants a spoken answer (\"How can I help you?\", \"Who am I speaking with?\", \"Please tell me the reason for your call\"), or someone just says \"Hello?\" and nothing else follows, or it answers what the assistant said. Be certain. A welcome or greeting (\"Thanks for calling …\"), information, or options to press a key don't count, even when they sound like a person.",
      hang_up: "No person is on the line, only an automated system, a recording, hold music or silence, and either what it said already achieves the goal; or the goal clearly can't be achieved on this call: the menu keeps repeating with no option that fits, the business is closed, or the number is not in service; or the call has been on hold for longer than hold_limit_seconds (seconds_on_hold is more).",
    },
  },
  key: {
    type: "choice",
    instructions: "If a menu option should be pressed now, which key is it?",
    criteria: Object.fromEntries([...KEYS.map((k) => [k, `the key ${k}`]), ["none", "no key should be pressed"]]),
  },
  hang_up_reason: {
    type: "choice",
    instructions: "If the call should end now, why?",
    criteria: {
      goal_done: "What the line said already achieves the goal.",
      no_way: "The goal can't be reached on this call (the menu loops with no fitting option, closed, not in service).",
      hold_limit: "The call has been on hold for longer than hold_limit_seconds.",
      neither: "The call shouldn't end.",
    },
  },
};

export type HangUpReason = "goal_done" | "no_way" | "hold_limit";

export interface NavigatorOptions {
  goal: string;
  checkEverySeconds: number;
  /** Longest hold before the navigator hangs up (seconds) */
  holdLimitSeconds: number;
  /** Probability the chosen action (and, to press, the key) needs */
  threshold: number;
  client: DecisionClient;
  /** Milliseconds; the call's answer time is t = 0 */
  now(): number;
  /** Resolves false when the press failed */
  press(keys: string): Promise<boolean>;
  hangUp(reason: HangUpReason): void;
  handOff(): void;
  log(msg: string): void;
}

/** The transcript sent with each check: the latest of the call, bounded. */
const MAX_TRANSCRIPT_CHARS = 4000;
/** With nothing new said, a look this often while the line plays music or silence */
const QUIET_CHECK_MS = 15_000;

export class MenuNavigator {
  private entries: TranscriptEntry[] = [];
  /** Line text not yet ended by a sentence break */
  private partial = "";
  private partialAt = 0;
  private presses: KeyPress[] = [];
  private sound = new LineSound(() => this.o.now() / 1000);
  private timer?: NodeJS.Timeout;
  private inFlight = false;
  private lastAction?: string;
  /** Transcript size at the last check, and at the navigator's last press */
  private seenChars = 0;
  private pressedAtChars = -1;
  private totalChars = 0;
  /** The quiet stretch (music or silence) at the last check, and when that was */
  private checkedQuietSince?: number;
  private lastCheckAt = 0;
  stopped = false;

  constructor(private o: NavigatorOptions) {}

  start() {
    this.timer = setInterval(() => void this.check(), this.o.checkEverySeconds * 1000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private t() {
    return Math.round(this.o.now() / 100) / 10;
  }

  /** Streamed text of the other side (gpt-live-transcribe deltas). */
  lineText(delta: string) {
    if (this.stopped || !delta) return;

    if (!this.partial) this.partialAt = this.t();
    this.partial += delta;
    this.totalChars += delta.length;
    // Keep sentences as entries; the unfinished rest stays partial.
    const m = this.partial.match(/^([\s\S]*[.!?])\s+([\s\S]*)$/);
    if (m && m[1].trim()) {
      this.entries.push({ t: this.partialAt, who: "line", text: m[1].trim() });
      this.partial = m[2];
      this.partialAt = this.t();
    }
  }

  /** What the voice model said. */
  assistantSaid(text: string) {
    if (this.stopped || !text.trim()) return;
    this.flushPartial();
    this.entries.push({ t: this.t(), who: "assistant", text: text.trim() });
    this.totalChars += text.length;
  }

  /** A key press, by either side. */
  pressed(by: KeyPress["by"], keys: string) {
    if (this.stopped) return;
    this.presses.push({ t: this.t(), by, keys });
    if (by === "navigator") this.pressedAtChars = this.totalChars;
  }

  /**
   * One speech-detector window of the line: speech probability and loudness
   * (RMS). Returns the second's sound when the window completes one.
   */
  lineSound(prob: number, rms: number) {
    return this.stopped ? undefined : this.sound.window(prob, rms);
  }

  private flushPartial() {
    if (this.partial.trim()) this.entries.push({ t: this.partialAt, who: "line", text: this.partial.trim() });
    this.partial = "";
  }

  state() {
    const all = [...this.entries, ...(this.partial.trim() ? [{ t: this.partialAt, who: "line" as const, text: this.partial.trim() }] : [])];
    // The most recent entries that fit.
    const transcript: TranscriptEntry[] = [];
    let used = 0;
    for (let i = all.length - 1; i >= 0 && used < MAX_TRANSCRIPT_CHARS; i--) {
      transcript.unshift(all[i]);
      used += all[i].text.length;
    }
    const lineAudio = this.sound.summary(this.presses.at(-1)?.t);
    return {
      goal: this.o.goal,
      seconds_into_call: this.t(),
      transcript,
      keys_pressed: [...this.presses],
      ...(lineAudio ? { line_audio: lineAudio } : {}),
      hold_limit_seconds: this.o.holdLimitSeconds,
    };
  }

  /** One look at the call; exported for tests. */
  async check() {
    if (this.stopped || this.inFlight) return;
    // When the line said something new (after our own press, only once the
    // menu has answered it); or, while it plays music or silence, when that
    // began and every QUIET_CHECK_MS, so a hold is timed.
    const said = this.totalChars !== this.seenChars && this.totalChars !== this.pressedAtChars;
    const quiet = this.sound.quietSince();
    const holding = quiet !== undefined && (quiet !== this.checkedQuietSince || this.o.now() - this.lastCheckAt >= QUIET_CHECK_MS);
    if (!said && !holding) return;
    this.seenChars = this.totalChars;
    this.checkedQuietSince = quiet;
    this.lastCheckAt = this.o.now();
    this.inFlight = true;
    try {
      const a = await this.o.client.decide(this.state(), QUESTIONS);
      if (this.stopped) return;
      const action = a.action?.choice;
      const p = (q: string, c: string) => a[q]?.probabilities?.[c] ?? 0;
      // Logged when the answer changes, not every few seconds.
      if (action !== this.lastAction) {
        this.lastAction = action;
        this.o.log(`navigator: ${action} (${p("action", action ?? "").toFixed(2)}, key ${a.key?.choice} ${p("key", a.key?.choice ?? "").toFixed(2)}) at ${this.t()}s`);
      }
      if (action === "hand_off" && p("action", "hand_off") >= this.o.threshold) {
        this.o.log(`navigator: a person is speaking (${p("action", "hand_off").toFixed(2)}); handing off`);
        this.stop();
        return this.o.handOff();
      }
      if (action === "hang_up" && p("action", "hang_up") >= this.o.threshold) {
        const reasons: HangUpReason[] = ["goal_done", "no_way", "hold_limit"];
        const reason = reasons.reduce((a, b) => (p("hang_up_reason", b) > p("hang_up_reason", a) ? b : a));
        this.o.log(`navigator: hanging up, ${reason} (${p("action", "hang_up").toFixed(2)})`);
        this.stop();
        return this.o.hangUp(reason);
      }
      const key = a.key?.choice;
      if (action === "press" && p("action", "press") >= this.o.threshold && key && KEYS.includes(key) && p("key", key) >= this.o.threshold) {
        this.o.log(`navigator: pressing ${key} (${p("action", "press").toFixed(2)}/${p("key", key).toFixed(2)})`);
        const at = this.presses.length;
        this.pressed("navigator", key);
        if (!(await this.o.press(key))) {
          // A failed press isn't one: forget it, and look again next time.
          this.presses.splice(at, 1);
          this.pressedAtChars = -1;
          this.seenChars = -1;
        }
      }
    } catch (err) {
      this.o.log(`navigator: check failed: ${err instanceof Error ? err.message : String(err)}`);
      // Try again at the next check, even with nothing new.
      this.seenChars = -1;
      this.checkedQuietSince = undefined;
    } finally {
      this.inFlight = false;
    }
  }
}
