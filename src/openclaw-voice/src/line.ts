// The phone line a call runs on, whatever carries it: an otacon phone
// (otacon.ts) or Twilio (twilio.ts). CallMission talks only to this.
//
// Commands (cmd): dial {to} and answer {call} resolve {call}; hangup {call};
// dtmf {digits} resolves {digits}; hold, resume and swap act on the lines;
// merge joins two lines into one call. Events: "call" (call.incoming,
// call.state, call.ended with a reason: remote, local, busy, no_answer,
// failed...), "audio" (pcm_s16le mono 16 kHz of the active line), "close".

import { EventEmitter } from "node:events";

export interface LineCall {
  id: string;
  number: string | null;
  numberSource?: "hfp" | "kiosk";
  direction: "outgoing" | "incoming";
  state: "dialing" | "alerting" | "incoming" | "active" | "held" | "ended";
  conference: boolean;
  startedAt: number;
  answeredAt?: number;
}

export class LineError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

/** A one-way call that plays another call's audio to someone (listen-in). */
export interface Listener {
  id: string;
  /** pcm_s16le, mono, 16 kHz */
  send(pcm: Buffer): void;
  hangUp(): Promise<void>;
  /** Called once when the listening call is over (they hung up, or we did) */
  onEnd(fn: (reason: string) => void): void;
}

export interface LineLink extends EventEmitter {
  /** Ready to place and take calls */
  readonly open: boolean;
  readonly calls: Map<string, LineCall>;
  /** Who this line is, for logs: the phone id or the number */
  readonly label: string;
  start(): void;
  stop(): void;
  cmd(type: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  /** Audio for the other party: pcm_s16le, mono, 16 kHz */
  sendAudio(pcm: Buffer): void;
  /** Resolves when playback reaches this point (false), or it was cleared (true). */
  mark(): Promise<boolean>;
  /** Drop queued audio; resolves with the milliseconds never played (0 if unknown). */
  clear(): Promise<number>;
  waitFor(callId: string, states: LineCall["state"][], timeoutMs: number): Promise<LineCall | null>;
  /**
   * Lines that must decide at once whether to take an incoming call
   * (Twilio's webhook) ask this; otherwise the call rings until answered.
   */
  screen?: (number: string | null) => boolean;
  /**
   * Lines whose events come from gateway requests (Twilio's webhooks and
   * streams) run them through this, so calls live in the plugin service's
   * async context, not in a request's (which OpenClaw closes).
   */
  runIn?: <T>(fn: () => T) => T;
  /**
   * Lines that can place an extra call while others are up (Twilio) offer
   * this: call `to`, say `intro`, then play what's sent. The call isn't one
   * of the line's calls: it never gets the voice model or call events, and
   * what the listener says is dropped.
   */
  listen?(to: string, intro: string): Promise<Listener>;
}

/** The call bookkeeping every line shares. */
export abstract class LineBase extends EventEmitter {
  readonly calls = new Map<string, LineCall>();
  open = false;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** Wait for a call to reach a state (or end). */
  waitFor(callId: string, states: LineCall["state"][], timeoutMs: number): Promise<LineCall | null> {
    const now = this.calls.get(callId);
    if (now && states.includes(now.state)) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (v: LineCall | null) => {
        clearTimeout(timer);
        this.off("call", onCall);
        resolve(v);
      };
      const onCall = (msg: any) => {
        if (msg.call?.id !== callId) return;
        if (msg.type === "call.ended") return done({ ...msg.call, state: "ended" });
        if (states.includes(msg.call.state)) done(msg.call);
      };
      const timer = setTimeout(() => done(this.calls.get(callId) ?? null), timeoutMs);
      this.on("call", onCall);
    });
  }
}
