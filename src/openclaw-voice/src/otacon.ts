// Client for otacon's ws/voice/control socket (docs/voice-ws.md in the
// otacon repo): commands with ids and acks, call events, marks, clear, and
// full-duplex call audio (pcm_s16le, mono, 16 kHz on the Bluetooth backend).

import { EventEmitter } from "node:events";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

export interface OtaconCall {
  id: string;
  number: string | null;
  numberSource?: "hfp" | "kiosk";
  direction: "outgoing" | "incoming";
  state: "dialing" | "alerting" | "incoming" | "active" | "held" | "ended";
  conference: boolean;
  startedAt: number;
  answeredAt?: number;
}

export class OtaconCommandError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

interface Pending {
  resolve(v: any): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Events: "hello" (msg), "call" (msg: call.incoming / call.state /
 * call.ended), "audio" (Buffer), "link" (up: boolean), "open", "close".
 */
export class OtaconLink extends EventEmitter {
  private ws?: WebSocket;
  private stopped = false;
  private next = 0;
  private pending = new Map<string, Pending>();
  private marks = new Map<string, (cleared: boolean) => void>();
  private retryMs = 1000;
  readonly calls = new Map<string, OtaconCall>();
  sampleRate = 16000;
  hfpConnected = false;
  open = false;

  constructor(
    private opts: { url: string; phoneId: string; takeover: boolean; logger: PluginLogger },
  ) {
    super();
    this.setMaxListeners(50);
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  private connect() {
    if (this.stopped) return;
    const base = this.opts.url.replace(/^http/, "ws");
    const url = `${base}/phones/${this.opts.phoneId}/ws/voice/control${this.opts.takeover ? "?takeover=1" : ""}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.retryMs = 1000;
      this.opts.logger.info(`[otacon-voice] connected to ${this.opts.phoneId}`);
      this.emit("open");
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.onText(ev.data);
      else this.emit("audio", Buffer.from(ev.data as ArrayBuffer));
    };
    ws.onclose = (ev) => {
      const wasOpen = this.open;
      this.open = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new OtaconCommandError("disconnected", "the otacon socket closed"));
      }
      this.pending.clear();
      for (const [, done] of this.marks) done(true);
      this.marks.clear();
      if (wasOpen) this.emit("close");
      if (this.stopped) return;
      // Taken over by another client: back off for a while instead of
      // fighting over the phone.
      const delay = ev.code === 4001 ? 60_000 : this.retryMs;
      if (ev.code === 4001) this.opts.logger.warn("[otacon-voice] another client took control of the phone");
      this.retryMs = Math.min(this.retryMs * 2, 15_000);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      // onclose follows; the reason (e.g. HTTP 409 while another client
      // holds the phone) isn't exposed by the WebSocket API.
    };
  }

  private onText(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello":
        this.sampleRate = msg.audio?.sampleRate ?? 16000;
        this.hfpConnected = Boolean(msg.hfp?.connected);
        this.calls.clear();
        for (const c of msg.calls ?? []) this.calls.set(c.id, c);
        this.emit("hello", msg);
        return;
      case "ack":
      case "error": {
        const p = msg.id != null ? this.pending.get(msg.id) : undefined;
        if (!p) {
          if (msg.type === "error") this.opts.logger.warn(`[otacon-voice] otacon error: ${msg.code} ${msg.message}`);
          return;
        }
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.type === "ack") p.resolve(msg.result ?? {});
        else p.reject(new OtaconCommandError(msg.code, msg.message));
        return;
      }
      case "mark": {
        const done = this.marks.get(msg.name);
        if (done) {
          this.marks.delete(msg.name);
          done(Boolean(msg.cleared));
        }
        return;
      }
      case "call.incoming":
      case "call.state":
      case "call.ended":
        if (msg.type === "call.ended") this.calls.delete(msg.call.id);
        else this.calls.set(msg.call.id, msg.call);
        this.emit("call", msg);
        return;
      case "hfp":
        this.hfpConnected = Boolean(msg.connected);
        return;
      case "audio.link":
        this.emit("link", Boolean(msg.up));
        return;
    }
  }

  /** Run a command; resolves with `ack.result`. */
  cmd(type: string, fields: Record<string, unknown> = {}, timeoutMs = 45_000): Promise<any> {
    const ws = this.ws;
    if (!ws || !this.open) return Promise.reject(new OtaconCommandError("disconnected", "not connected to otacon"));
    const id = String(++this.next);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OtaconCommandError("timeout", `${type}: no reply from otacon`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...fields, type, id }));
    });
  }

  /** Queue audio for the other party (pcm_s16le mono at sampleRate). */
  sendAudio(pcm: Buffer) {
    if (this.open && pcm.length) this.ws!.send(pcm);
  }

  /** Resolves when playback reaches this point (false), or it was cleared (true). */
  mark(): Promise<boolean> {
    if (!this.open) return Promise.resolve(true);
    const name = `m${++this.next}`;
    return new Promise((resolve) => {
      this.marks.set(name, resolve);
      this.ws!.send(JSON.stringify({ type: "mark", name }));
    });
  }

  /** Drop queued uplink audio; resolves with the milliseconds never played. */
  async clear(): Promise<number> {
    try {
      const r = await this.cmd("clear", {}, 5_000);
      return Number(r.droppedMs) || 0;
    } catch {
      return 0;
    }
  }

  /** Wait for a call to reach a state (or end). */
  waitFor(callId: string, states: OtaconCall["state"][], timeoutMs: number): Promise<OtaconCall | null> {
    const now = this.calls.get(callId);
    if (now && states.includes(now.state)) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (v: OtaconCall | null) => {
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
