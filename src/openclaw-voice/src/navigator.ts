// The phone-menu navigator. On a call an agent places, a decision model
// (OpenRouter's Decisions API) reads the live transcript of the line every
// few seconds, beside the voice model, and decides one of:
//   - press a menu option ("for directions, press 2")
//   - hang up: the goal is done, or there's no way to reach it (a loop with
//     no fitting option, closed, not in service)
//   - hand off: a person is speaking. The navigator stops for the rest of the
//     call and the voice model carries on alone.
//   - wait
// It never speaks and never types in information (a phone number, a date of
// birth): that's the voice model's job, which keeps its keypad throughout.
// Each side sees the other's key presses: the navigator in its transcript,
// the voice model through notes (call.ts).

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
      "You navigate automated phone menus for an assistant making this call; the assistant talks to people and types in or says any information. Act as soon as you can. What should you do right now?",
    criteria: {
      wait: "Nothing to do now: no option that fits the goal has been offered yet; or the key for the fitting option was already pressed and the line hasn't answered it yet; or it's hold music or a hold message; or the line asks for information to be typed in or said (the assistant does that).",
      press: "An automated menu has offered an option that fits the goal, and its key hasn't been pressed yet. Press it right away, without waiting for the rest of the menu.",
      hand_off: "A live person is on the line: someone greets, answers or asks the assistant something, or goes back and forth with it. (Automated voices read menus, prompts and recorded messages, and don't respond to what the assistant says.)",
      hang_up: "No person is on the line, only an automated system or recording, and either what it said already achieves the goal, or the goal clearly can't be achieved on this call: the menu keeps repeating with no option that fits, the business is closed, or the number is not in service.",
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
      neither: "The call shouldn't end.",
    },
  },
};

export interface NavigatorOptions {
  goal: string;
  checkEverySeconds: number;
  pressThreshold: number;
  handOffThreshold: number;
  hangUpThreshold: number;
  client: DecisionClient;
  /** Milliseconds; the call's answer time is t = 0 */
  now(): number;
  press(keys: string): Promise<void>;
  hangUp(reason: "goal_done" | "no_way"): void;
  handOff(): void;
  log(msg: string): void;
}

/** The transcript sent with each check: the latest of the call, bounded. */
const MAX_TRANSCRIPT_CHARS = 4000;

export class MenuNavigator {
  private entries: TranscriptEntry[] = [];
  /** Line text not yet ended by a sentence break */
  private partial = "";
  private partialAt = 0;
  private presses: KeyPress[] = [];
  private holding = false;
  private holdSince = 0;
  private timer?: NodeJS.Timeout;
  private inFlight = false;
  private lastAction?: string;
  /** Transcript size at the last check, and at the navigator's last press */
  private seenChars = 0;
  private pressedAtChars = -1;
  private totalChars = 0;
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

  hold(on: boolean) {
    this.holding = on;
    this.holdSince = on ? this.o.now() : 0;
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
    return {
      goal: this.o.goal,
      seconds_into_call: this.t(),
      on_hold: this.holding,
      seconds_on_hold: this.holding ? Math.round((this.o.now() - this.holdSince) / 1000) : 0,
      transcript,
      keys_pressed: this.presses,
    };
  }

  /** One look at the call; exported for tests. */
  async check() {
    if (this.stopped || this.inFlight) return;
    // Only when the line said something new, and after our own press only
    // once the menu has answered it.
    if (this.totalChars === this.seenChars || this.totalChars === this.pressedAtChars) return;
    this.seenChars = this.totalChars;
    this.inFlight = true;
    try {
      const a = await this.o.client.decide(this.state(), QUESTIONS);
      if (this.stopped) return;
      const action = a.action?.choice;
      const p = (q: string, c: string) => a[q]?.probabilities?.[c] ?? 0;
      // Logged when the answer changes, not every few seconds.
      if (action !== this.lastAction) {
        this.lastAction = action;
        this.o.log(`navigator: ${action} (${p("action", action ?? "").toFixed(2)}) at ${this.t()}s`);
      }
      if (action === "hand_off" && p("action", "hand_off") >= this.o.handOffThreshold) {
        this.o.log(`navigator: a person is speaking (${p("action", "hand_off").toFixed(2)}); handing off`);
        this.stop();
        return this.o.handOff();
      }
      if (action === "hang_up" && p("action", "hang_up") > this.o.hangUpThreshold && !this.holding) {
        const reason = p("hang_up_reason", "goal_done") >= p("hang_up_reason", "no_way") ? "goal_done" : "no_way";
        this.o.log(`navigator: hanging up, ${reason} (${p("action", "hang_up").toFixed(2)})`);
        this.stop();
        return this.o.hangUp(reason);
      }
      const key = a.key?.choice;
      if (action === "press" && p("action", "press") >= this.o.pressThreshold && key && KEYS.includes(key) && p("key", key) >= this.o.pressThreshold) {
        this.o.log(`navigator: pressing ${key} (${p("action", "press").toFixed(2)}/${p("key", key).toFixed(2)})`);
        this.pressed("navigator", key);
        await this.o.press(key);
      }
    } catch (err) {
      this.o.log(`navigator: check failed: ${err instanceof Error ? err.message : String(err)}`);
      // Try again at the next check, even with no new text.
      this.seenChars = -1;
    } finally {
      this.inFlight = false;
    }
  }
}
