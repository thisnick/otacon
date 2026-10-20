// A phone line on Twilio (Programmable Voice): calls through the REST API,
// call audio through bidirectional Media Streams, call states from status
// callbacks. Each call has its own stream; the line plays the part of a
// phone: one active call gets the audio, others are held (silent), merge
// joins two calls in a conference.
//
// Twilio can't send key presses over a media stream, so a key press
// redirects the call: <Play digits> then a new <Connect><Stream>; the
// stream is replaced and the call carries on.
//
// Routes (index.ts mounts them under /otacon-voice/twilio/<line id>/, and
// publicUrl is where Twilio reaches that):
//   POST answer: incoming calls (the number's voice URL): TwiML, or
//     <Reject/> for callers the runtime doesn't take
//   POST status: call status callbacks
//   GET  stream: the media stream WebSocket
// The webhooks are checked with X-Twilio-Signature, the stream with a token
// in its parameters.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { WebSocketServer, type WebSocket } from "ws";
import { MuLawToPcm16k, Pcm16kToMuLaw } from "./g711.js";
import { LineBase, LineError, type LineCall, type LineLink, type Listener } from "./line.js";

export interface TwilioLineOptions {
  id: string;
  accountSid: string;
  authToken: string;
  fromNumber: string;
  /** Public base URL of this line's routes, without a trailing slash */
  publicUrl: string;
  ringTimeoutSeconds: number;
  logger: PluginLogger;
  fetchImpl?: typeof fetch;
}

interface Leg {
  call: LineCall;
  ws?: WebSocket;
  streamSid?: string;
  held: boolean;
  /** We hung up (the end reason is "local") */
  hungUp: boolean;
  /** A redirect is replacing the stream: its stop isn't the end of the call */
  redirecting: boolean;
  marks: Map<string, (cleared: boolean) => void>;
  onStream: (() => void)[];
  up: MuLawToPcm16k;
  down: Pcm16kToMuLaw;
}

const STATUS: Record<string, LineCall["state"] | undefined> = {
  queued: "dialing",
  initiated: "dialing",
  ringing: "alerting",
  "in-progress": "active",
};
const END_REASON: Record<string, string> = {
  busy: "busy",
  "no-answer": "no_answer",
  failed: "failed",
  canceled: "canceled",
};

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A listen-in call: one way, outside the line's calls. */
interface ListenLeg {
  sid: string;
  ws?: WebSocket;
  streamSid?: string;
  down: Pcm16kToMuLaw;
  ended: boolean;
  onEnd: ((reason: string) => void)[];
}

export class TwilioLine extends LineBase implements LineLink {
  private legs = new Map<string, Leg>();
  private listenLegs = new Map<string, ListenLeg>();
  private wss = new WebSocketServer({ noServer: true });
  /** Proves a media stream is one we asked for */
  private streamToken = randomBytes(18).toString("base64url");
  private nextMark = 0;
  private stopped = false;
  private fetchImpl: typeof fetch;
  screen?: (number: string | null) => boolean;
  runIn: <T>(fn: () => T) => T = (fn) => fn();

  constructor(private o: TwilioLineOptions) {
    super();
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  get label() {
    return `${this.o.id} (${this.o.fromNumber})`;
  }

  start() {
    this.stopped = false;
    void this.check();
  }

  stop() {
    this.stopped = true;
    this.open = false;
    for (const leg of this.legs.values()) leg.ws?.close();
    for (const l of this.listenLegs.values()) l.ws?.close();
    this.wss.close();
  }

  /** Ready once the account answers (a wrong SID or token shows here). */
  private async check() {
    try {
      await this.api("GET", `/Accounts/${this.o.accountSid}.json`);
      this.open = true;
      this.o.logger.info(`[otacon-voice] Twilio line ${this.label} ready`);
    } catch (err) {
      this.o.logger.warn(`[otacon-voice] Twilio line ${this.o.id}: ${String(err).slice(0, 200)}; retrying in 60 s`);
      if (!this.stopped) setTimeout(() => void this.check(), 60_000).unref?.();
    }
  }

  // ---- REST ----

  private async api(method: string, path: string, form?: Record<string, string | string[]>) {
    let body: URLSearchParams | undefined;
    if (form) {
      body = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    }
    const res = await this.fetchImpl(`https://api.twilio.com/2010-04-01${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.o.accountSid}:${this.o.authToken}`).toString("base64")}`,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const payload: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new LineError("twilio", `${payload?.message ?? `HTTP ${res.status}`} (${payload?.code ?? res.status})`);
    return payload;
  }

  private callUrl(sid: string) {
    return `/Accounts/${this.o.accountSid}/Calls/${sid}.json`;
  }

  private streamTwiml(prefix = "") {
    const url = this.o.publicUrl.replace(/^http/, "ws") + "/stream";
    return `<Response>${prefix}<Connect><Stream url="${xml(url)}"><Parameter name="token" value="${this.streamToken}"/></Stream></Connect></Response>`;
  }

  // ---- calls ----

  private newLeg(call: LineCall): Leg {
    const leg: Leg = {
      call,
      held: false,
      hungUp: false,
      redirecting: false,
      marks: new Map(),
      onStream: [],
      up: new MuLawToPcm16k(),
      down: new Pcm16kToMuLaw(),
    };
    this.legs.set(call.id, leg);
    this.calls.set(call.id, call);
    return leg;
  }

  private setState(leg: Leg, state: LineCall["state"]) {
    if (leg.call.state === state || leg.call.state === "ended") return;
    leg.call = { ...leg.call, state, ...(state === "active" && !leg.call.answeredAt ? { answeredAt: Date.now() } : {}) };
    this.calls.set(leg.call.id, leg.call);
    this.emit("call", { type: "call.state", call: leg.call });
  }

  private ended(leg: Leg, reason: string) {
    if (leg.call.state === "ended") return;
    leg.call = { ...leg.call, state: "ended" };
    this.calls.delete(leg.call.id);
    this.legs.delete(leg.call.id);
    this.dropMarks(leg);
    leg.ws?.close();
    this.emit("call", { type: "call.ended", call: leg.call, reason: leg.hungUp ? "local" : reason });
  }

  /** The call that gets the audio: the newest live one that isn't held. */
  private active(): Leg | undefined {
    const live = [...this.legs.values()].filter((l) => !l.held && l.call.state !== "ended");
    return live.at(-1);
  }

  private leg(id: unknown): Leg {
    const leg = this.legs.get(String(id ?? ""));
    if (!leg) throw new LineError("no_call", `no call ${String(id)}`);
    return leg;
  }

  private waitStream(leg: Leg, timeoutMs: number): Promise<boolean> {
    if (leg.ws && leg.streamSid && !leg.redirecting) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      leg.onStream.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  /** Point a call at new TwiML (its stream, if any, ends). */
  private async redirect(leg: Leg, twiml: string) {
    leg.redirecting = true;
    this.dropMarks(leg);
    try {
      await this.api("POST", this.callUrl(leg.call.id), { Twiml: twiml });
    } catch (err) {
      leg.redirecting = false;
      throw err;
    }
  }

  async cmd(type: string, f: Record<string, unknown> = {}): Promise<any> {
    if (!this.open) throw new LineError("disconnected", `Twilio line ${this.o.id} isn't ready`);
    switch (type) {
      case "dial": {
        const to = String(f.to ?? "");
        const r = await this.api("POST", `/Accounts/${this.o.accountSid}/Calls.json`, {
          To: to,
          From: this.o.fromNumber,
          Twiml: this.streamTwiml(),
          Timeout: String(this.o.ringTimeoutSeconds + 5),
          StatusCallback: `${this.o.publicUrl}/status`,
          StatusCallbackMethod: "POST",
          StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        });
        const leg = this.newLeg({ id: r.sid, number: to, direction: "outgoing", state: "dialing", conference: false, startedAt: Date.now() });
        this.emit("call", { type: "call.state", call: leg.call });
        return { call: leg.call };
      }
      case "answer": {
        // Incoming calls are answered by the TwiML of the answer route; the
        // call is up once its stream is.
        const leg = this.leg(f.call);
        if (!(await this.waitStream(leg, 15_000))) throw new LineError("timeout", "the call's audio stream didn't start");
        return { call: leg.call };
      }
      case "hangup": {
        const leg = this.leg(f.call);
        leg.hungUp = true;
        await this.api("POST", this.callUrl(leg.call.id), { Status: "completed" }).catch((err) => {
          // Already over: Twilio refuses to complete a finished call.
          if (!/not in-progress|completed/i.test(String(err))) throw err;
        });
        return {};
      }
      case "dtmf": {
        const digits = String(f.digits ?? "");
        if (!/^[0-9*#wW]+$/.test(digits)) throw new LineError("bad_digits", `can't press "${digits}"`);
        const leg = this.active();
        if (!leg) throw new LineError("no_call", "no active call");
        await this.redirect(leg, this.streamTwiml(`<Play digits="${digits.toLowerCase()}"/>`));
        // Back once the new stream is up, so presses don't overlap.
        await this.waitStream(leg, 10_000 + digits.length * 1000);
        return { digits };
      }
      case "hold": {
        const leg = this.active();
        if (!leg) throw new LineError("no_call", "no active call");
        this.dropMarks(leg);
        leg.held = true;
        this.setState(leg, "held");
        return {};
      }
      case "resume": {
        const held = [...this.legs.values()].filter((l) => l.held);
        if (!held.length) throw new LineError("no_call", "no call on hold");
        if (this.active()) throw new LineError("busy", "another call is active; swap instead");
        const leg = held.at(-1)!;
        leg.held = false;
        this.setState(leg, "active");
        return {};
      }
      case "swap": {
        const now = this.active();
        const held = [...this.legs.values()].filter((l) => l.held).at(-1);
        if (!now || !held) throw new LineError("no_call", "swap needs an active and a held call");
        this.dropMarks(now);
        now.held = true;
        held.held = false;
        // The one taken off hold becomes the newest, so active() finds it.
        this.legs.delete(held.call.id);
        this.legs.set(held.call.id, held);
        this.setState(now, "held");
        this.setState(held, "active");
        return {};
      }
      case "merge": {
        const live = [...this.legs.values()].filter((l) => l.call.state !== "ended");
        if (live.length !== 2) throw new LineError("bad_state", "merge needs two calls");
        const room = `otacon-${randomBytes(6).toString("hex")}`;
        const twiml = `<Response><Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true">${room}</Conference></Dial></Response>`;
        for (const leg of live) {
          await this.redirect(leg, twiml);
          leg.held = false;
          leg.call = { ...leg.call, conference: true, state: "active" };
          this.calls.set(leg.call.id, leg.call);
          this.emit("call", { type: "call.state", call: leg.call });
        }
        return {};
      }
      default:
        throw new LineError("unsupported", `${type} isn't supported on Twilio`);
    }
  }

  // ---- listen-in ----

  async listen(to: string, intro: string): Promise<Listener> {
    if (!this.open) throw new LineError("disconnected", `Twilio line ${this.o.id} isn't ready`);
    const r = await this.api("POST", `/Accounts/${this.o.accountSid}/Calls.json`, {
      To: to,
      From: this.o.fromNumber,
      Twiml: this.streamTwiml(`<Say>${xml(intro)}</Say>`),
      Timeout: String(this.o.ringTimeoutSeconds + 5),
      StatusCallback: `${this.o.publicUrl}/status`,
      StatusCallbackMethod: "POST",
      StatusCallbackEvent: ["completed"],
    });
    const leg: ListenLeg = { sid: r.sid, down: new Pcm16kToMuLaw(), ended: false, onEnd: [] };
    this.listenLegs.set(leg.sid, leg);
    return {
      id: leg.sid,
      send: (pcm) => {
        if (leg.ended || !leg.ws || !leg.streamSid || !pcm.length) return;
        const payload = leg.down.process(pcm);
        if (payload.length) leg.ws.send(JSON.stringify({ event: "media", streamSid: leg.streamSid, media: { payload: payload.toString("base64") } }));
      },
      hangUp: async () => {
        if (leg.ended) return;
        await this.api("POST", this.callUrl(leg.sid), { Status: "completed" }).catch(() => undefined);
        this.listenerEnded(leg, "local");
      },
      onEnd: (fn) => void leg.onEnd.push(fn),
    };
  }

  private listenerEnded(leg: ListenLeg, reason: string) {
    if (leg.ended) return;
    leg.ended = true;
    this.listenLegs.delete(leg.sid);
    leg.ws?.close();
    for (const f of leg.onEnd.splice(0)) f(reason);
  }

  // ---- audio ----

  sendAudio(pcm: Buffer) {
    const leg = this.active();
    if (!leg?.ws || !leg.streamSid || leg.redirecting || !pcm.length) return;
    const payload = leg.down.process(pcm);
    if (payload.length) leg.ws.send(JSON.stringify({ event: "media", streamSid: leg.streamSid, media: { payload: payload.toString("base64") } }));
  }

  mark(): Promise<boolean> {
    const leg = this.active();
    if (!leg?.ws || !leg.streamSid || leg.redirecting) return Promise.resolve(true);
    const name = `m${++this.nextMark}`;
    return new Promise((resolve) => {
      leg.marks.set(name, resolve);
      leg.ws!.send(JSON.stringify({ event: "mark", streamSid: leg.streamSid, mark: { name } }));
    });
  }

  async clear(): Promise<number> {
    const leg = this.active();
    if (leg?.ws && leg.streamSid) leg.ws.send(JSON.stringify({ event: "clear", streamSid: leg.streamSid }));
    if (leg) this.dropMarks(leg);
    return 0;
  }

  private dropMarks(leg: Leg) {
    for (const done of leg.marks.values()) done(true);
    leg.marks.clear();
  }

  // ---- routes ----

  /** Whether a webhook came from Twilio (X-Twilio-Signature over the public URL and the form). */
  private signed(path: string, query: string, params: URLSearchParams, signature: string | undefined): boolean {
    if (!signature) return false;
    let data = `${this.o.publicUrl}/${path}${query}`;
    for (const k of [...new Set(params.keys())].sort()) for (const v of params.getAll(k)) data += k + v;
    const expected = createHmac("sha1", this.o.authToken).update(data).digest();
    const got = Buffer.from(signature, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  /** POST answer / status. `path` is what follows the line's route prefix. */
  async handleHttp(path: string, query: string, req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    if (req.method !== "POST" || !this.signed(path, query, params, req.headers["x-twilio-signature"] as string | undefined)) {
      this.o.logger.warn(`[otacon-voice] Twilio line ${this.o.id}: refused an unsigned ${req.method} ${path}`);
      res.statusCode = 403;
      res.end();
      return;
    }
    if (path === "answer") return this.runIn(() => this.onIncoming(params, res));
    if (path === "status") {
      this.runIn(() => this.onStatus(params));
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  }

  private onIncoming(params: URLSearchParams, res: ServerResponse) {
    const sid = params.get("CallSid") ?? "";
    const from = params.get("From") || null;
    const reply = (twiml: string) => {
      res.setHeader("Content-Type", "text/xml");
      res.end(`<?xml version="1.0" encoding="UTF-8"?>${twiml}`);
    };
    if (!this.open || !sid || !this.screen?.(from)) {
      this.o.logger.info(`[otacon-voice] Twilio line ${this.o.id}: rejecting a call from ${from ?? "an unknown number"}`);
      return reply("<Response><Reject/></Response>");
    }
    const leg = this.newLeg({ id: sid, number: from, direction: "incoming", state: "incoming", conference: false, startedAt: Date.now() });
    reply(this.streamTwiml());
    this.emit("call", { type: "call.incoming", call: leg.call });
  }

  private onStatus(params: URLSearchParams) {
    const status = params.get("CallStatus") ?? "";
    const listener = this.listenLegs.get(params.get("CallSid") ?? "");
    if (listener) {
      if (status === "completed" || END_REASON[status]) this.listenerEnded(listener, status === "completed" ? "remote" : END_REASON[status]);
      return;
    }
    const leg = this.legs.get(params.get("CallSid") ?? "");
    if (!leg) return;
    if (status === "completed") return this.ended(leg, "remote");
    if (END_REASON[status]) return this.ended(leg, END_REASON[status]);
    const state = STATUS[status];
    // A held call stays held; Twilio reports it in progress.
    if (state && !(state === "active" && leg.held)) this.setState(leg, state);
  }

  /** GET stream (WebSocket upgrade). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onStreamSocket(ws));
  }

  private onStreamSocket(ws: WebSocket) {
    let leg: Leg | undefined;
    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.runIn(() => onMessage(msg));
    });
    const onMessage = (msg: any) => {
      switch (msg.event) {
        case "start": {
          const token = String(msg.start?.customParameters?.token ?? "");
          const listener = this.listenLegs.get(String(msg.start?.callSid ?? ""));
          if (listener && token === this.streamToken) {
            listener.ws = ws;
            listener.streamSid = String(msg.streamSid ?? msg.start?.streamSid ?? "");
            ws.on("close", () => this.listenerEnded(listener, "remote"));
            return;
          }
          leg = this.legs.get(String(msg.start?.callSid ?? ""));
          if (token !== this.streamToken || !leg) {
            this.o.logger.warn(`[otacon-voice] Twilio line ${this.o.id}: closing a stream it didn't ask for`);
            leg = undefined;
            return ws.close();
          }
          const old = leg.ws;
          leg.ws = ws;
          leg.streamSid = String(msg.streamSid ?? msg.start?.streamSid ?? "");
          leg.redirecting = false;
          leg.up = new MuLawToPcm16k();
          leg.down = new Pcm16kToMuLaw();
          if (old && old !== ws) old.close();
          if (!leg.held && leg.call.state !== "active") this.setState(leg, "active");
          for (const f of leg.onStream.splice(0)) f();
          return;
        }
        case "media": {
          if (!leg || leg.ws !== ws || leg.held || this.active() !== leg || msg.media?.track === "outbound") return;
          this.emit("audio", leg.up.process(Buffer.from(String(msg.media?.payload ?? ""), "base64")));
          return;
        }
        case "mark": {
          const done = leg?.marks.get(String(msg.mark?.name ?? ""));
          if (done) {
            leg!.marks.delete(String(msg.mark.name));
            done(false);
          }
          return;
        }
        case "stop": {
          // A redirect (key press, merge) replaces the stream; otherwise
          // the call is over, whatever its status callback says later.
          if (leg && leg.ws === ws && !leg.redirecting && !leg.call.conference) this.ended(leg, "remote");
          return;
        }
      }
    };
    ws.on("close", () => {
      if (leg && leg.ws === ws) {
        leg.ws = undefined;
        leg.streamSid = undefined;
      }
    });
  }
}
