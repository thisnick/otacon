/**
 * `otacon call listen` — follow a phone's call on the read-only
 * `ws/voice/monitor` socket (see docs/voice-ws.md, "Read-only clients").
 *
 * The socket sends a JSON `hello` first, then binary frames of stereo
 * interleaved pcm_s16le (left: the other party, right: what otacon plays
 * into the call) mixed with JSON call events. Events are printed to stderr;
 * audio is either written to a WAV file (--out) or streamed as WAV into the
 * first audio player found on PATH (ffplay, sox's `play`, aplay).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Call, OtaconClient } from "../client.js";

export interface ListenOptions {
  /** Save a stereo 16-bit WAV here instead of playing live */
  out?: string;
  /** Print events as raw JSON lines instead of formatted lines */
  json?: boolean;
}

interface MonitorHello {
  type: "hello";
  phoneId?: string;
  number?: string | null;
  audio?: { format?: string; sampleRate?: number; channels?: number; channelMap?: string[] };
  audioLink?: boolean;
  hfp?: { connected?: boolean; chld?: string[] };
  calls?: Call[];
}

type MonitorEvent = Record<string, unknown> & { type?: string; audioPos?: number; ts?: number };

/** Players that read a WAV stream from stdin, in order of preference. */
const PLAYERS: Array<{ bin: string; args: string[] }> = [
  { bin: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "error", "-"] },
  { bin: "play", args: ["-q", "-t", "wav", "-"] }, // sox
  { bin: "aplay", args: ["-q", "-"] }, // alsa-utils
];

const MAX_U32 = 0xffffffff;

function wavHeader(sampleRate: number, channels: number, dataBytes: number): Buffer {
  const blockAlign = channels * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(Math.min(36 + dataBytes, MAX_U32), 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36, "ascii");
  h.writeUInt32LE(Math.min(dataBytes, MAX_U32), 40);
  return h;
}

function findOnPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

interface AudioSink {
  start(sampleRate: number, channels: number): void;
  write(pcm: Buffer): void;
  /** Flush and close; returns a summary line, if any. */
  finish(): string | undefined;
}

/** Writes a WAV file; the RIFF sizes are patched in finish(). */
class WavFileSink implements AudioSink {
  private fd: number;
  private dataBytes = 0;
  private sampleRate = 0;
  private channels = 0;
  private started = false;
  private full = false;
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    // Open up front so a bad path fails before connecting.
    this.fd = fs.openSync(file, "w");
  }

  start(sampleRate: number, channels: number): void {
    if (this.started) return;
    this.started = true;
    this.sampleRate = sampleRate;
    this.channels = channels;
    fs.writeSync(this.fd, wavHeader(sampleRate, channels, 0));
  }

  write(pcm: Buffer): void {
    if (!this.started || this.full) return;
    if (this.dataBytes + pcm.length > MAX_U32 - 36) {
      this.full = true;
      process.stderr.write("WAV size limit (4 GB) reached; no more audio is saved\n");
      return;
    }
    fs.writeSync(this.fd, pcm);
    this.dataBytes += pcm.length;
  }

  finish(): string | undefined {
    if (!this.started) {
      fs.closeSync(this.fd);
      fs.rmSync(this.file, { force: true });
      return undefined;
    }
    const header = wavHeader(this.sampleRate, this.channels, this.dataBytes);
    fs.writeSync(this.fd, header, 4, 4, 4); // RIFF chunk size
    fs.writeSync(this.fd, header, 40, 4, 40); // data chunk size
    fs.closeSync(this.fd);
    const secs = this.dataBytes / (this.sampleRate * this.channels * 2);
    return `Saved ${secs.toFixed(1)}s (${this.channels} ch, ${this.sampleRate} Hz) to ${this.file}`;
  }
}

/** Streams WAV into an external player's stdin. */
class PlayerSink implements AudioSink {
  private proc: ChildProcess | undefined;
  private readonly player: { bin: string; path: string; args: string[] };
  private readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void;

  constructor(
    player: { bin: string; path: string; args: string[] },
    onExit: (code: number | null, signal: NodeJS.Signals | null) => void
  ) {
    this.player = player;
    this.onExit = onExit;
  }

  start(sampleRate: number, channels: number): void {
    if (this.proc) return;
    // Own process group: the terminal's Ctrl-C reaches only us, and we stop
    // the player by ending its stdin (it exits at EOF).
    const proc = spawn(this.player.path, this.player.args, {
      stdio: ["pipe", "ignore", "inherit"],
      detached: true,
    });
    proc.stdin?.on("error", () => {
      // Player went away; its exit is handled below.
    });
    proc.on("error", (e) => {
      process.stderr.write(`${this.player.bin}: ${e.message}\n`);
    });
    proc.on("exit", (code, signal) => this.onExit(code, signal));
    // Streaming header: maximum sizes mean "until EOF" to all three players.
    proc.stdin?.write(wavHeader(sampleRate, channels, MAX_U32));
    this.proc = proc;
  }

  write(pcm: Buffer): void {
    const stdin = this.proc?.stdin;
    if (stdin && !stdin.destroyed) stdin.write(pcm);
  }

  finish(): string | undefined {
    const stdin = this.proc?.stdin;
    if (stdin && !stdin.destroyed) stdin.end();
    return undefined;
  }
}

function clock(ms?: number): string {
  return (typeof ms === "number" ? new Date(ms) : new Date()).toTimeString().slice(0, 8);
}

function callLine(c: Call): string {
  return [c.id, c.number ?? "unknown-number", c.direction, c.state, c.conference ? "conference" : ""]
    .filter(Boolean)
    .join("  ");
}

function formatEvent(ev: MonitorEvent, sampleRate: number): string {
  const at = typeof ev.audioPos === "number" && sampleRate > 0
    ? ` +${(ev.audioPos / sampleRate).toFixed(2)}s`
    : "";
  const prefix = `[${clock(ev.ts)}${at}]`;
  const type = String(ev.type ?? "?");
  const call = ev.call as Call | undefined;
  switch (type) {
    case "hello": {
      const h = ev as unknown as MonitorHello;
      const a = h.audio ?? {};
      const lines = [
        `${prefix} connected to ${h.phoneId ?? "phone"}${h.number ? ` (${h.number})` : ""}: ` +
          `${a.sampleRate ?? "?"} Hz, ${a.channels ?? "?"} ch` +
          `${a.channelMap ? ` [${a.channelMap.join(", ")}]` : ""}; ` +
          `audio link ${h.audioLink ? "up" : "down"}; HFP ${h.hfp?.connected ? "connected" : "disconnected"}`,
      ];
      const calls = h.calls ?? [];
      if (calls.length === 0) lines.push(`${prefix} no calls`);
      for (const c of calls) lines.push(`${prefix} call ${callLine(c)}`);
      return lines.join("\n");
    }
    case "call.incoming":
    case "call.state":
      return `${prefix} ${type.padEnd(13)} ${call ? callLine(call) : "-"}`;
    case "call.ended": {
      const why = [ev.reason ? `reason=${ev.reason}` : "", ev.cause ? `cause=${ev.cause}` : ""]
        .filter(Boolean)
        .join(" ");
      return `${prefix} ${type.padEnd(13)} ${call ? callLine(call) : "-"}${why ? `  ${why}` : ""}`;
    }
    case "audio.link":
      return `${prefix} ${type.padEnd(13)} ${ev.up ? "up" : "down"}`;
    case "hfp":
      return `${prefix} ${type.padEnd(13)} ${ev.connected ? "connected" : "disconnected"}`;
    default: {
      const { type: _t, ts: _ts, audioPos: _p, ...rest } = ev;
      return `${prefix} ${type.padEnd(13)} ${JSON.stringify(rest)}`;
    }
  }
}

/**
 * Node's WebSocket reports no reason for a failed upgrade, so probe the same
 * phone over HTTP to tell "host unreachable" from "no such phone".
 */
async function connectFailureReason(client: OtaconClient): Promise<string> {
  try {
    const res = await fetch(`${client.baseUrl}/api/calls/status`);
    if (res.status === 404) return "phone not found on this host (check --phone / the phone id)";
    if (res.ok) {
      return "the host answers HTTP but refused the monitor socket (is it running a build with ws/voice/monitor?)";
    }
    return `the host answered HTTP ${res.status}`;
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    return err.cause?.message || err.cause?.code || err.message;
  }
}

/**
 * Listen until Ctrl-C, the server closes the socket, or the player exits.
 * Resolves with the process exit code.
 */
export async function listenCall(client: OtaconClient, opts: ListenOptions): Promise<number> {
  if (typeof WebSocket === "undefined") {
    throw new Error("otacon call listen needs Node 22 or newer (global WebSocket)");
  }

  const log = (line: string) => process.stderr.write(`${line}\n`);
  let sink: AudioSink | undefined;
  let ws: WebSocket | undefined;
  let stopping = false;
  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  // Single exit path: Ctrl-C, server close, connect failure, or player exit.
  const finish = (code: number, message?: string): void => {
    if (stopping) return;
    stopping = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      ws?.close(1000);
    } catch {
      // already closed
    }
    if (message) log(message);
    const summary = sink?.finish();
    if (summary) log(summary);
    resolveDone(code);
  };
  const onSignal = () => finish(0);
  let playerName = "";

  if (opts.out) {
    sink = new WavFileSink(opts.out);
  } else {
    const found = PLAYERS.map((p) => ({ ...p, path: findOnPath(p.bin) })).find((p) => p.path);
    if (!found || !found.path) {
      throw new Error(
        "no audio player found on PATH (ffplay, play or aplay): install ffmpeg, sox or " +
          "alsa-utils, or save the call with --out <file.wav>"
      );
    }
    playerName = found.bin;
    sink = new PlayerSink({ bin: found.bin, path: found.path, args: found.args }, (code, signal) => {
      // Only reached if the player quits before we stop it.
      finish(code === 0 ? 0 : 1, `${found.bin} exited (${signal ?? `code ${code}`})`);
    });
  }

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const url = client.wsUrl("/ws/voice/monitor");
  let opened = false;
  let helloSeen = false;
  let sampleRate = 0;
  let lastError = "";

  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    opened = true;
  });

  ws.addEventListener("message", (msg: MessageEvent) => {
    if (typeof msg.data !== "string") {
      if (helloSeen) sink?.write(Buffer.from(msg.data as ArrayBuffer));
      return;
    }
    let ev: MonitorEvent;
    try {
      ev = JSON.parse(msg.data) as MonitorEvent;
    } catch {
      log(`(unparseable message: ${msg.data.slice(0, 200)})`);
      return;
    }
    if (ev.type === "hello" && !helloSeen) {
      const audio = (ev as unknown as MonitorHello).audio ?? {};
      if (audio.format && audio.format !== "pcm_s16le") {
        log(`warning: unexpected audio format ${audio.format}; writing it as 16-bit PCM`);
      }
      sampleRate = audio.sampleRate ?? 16000;
      const channels = audio.channels ?? 2;
      sink?.start(sampleRate, channels);
      helloSeen = true;
      log(opts.json ? JSON.stringify(ev) : formatEvent(ev, sampleRate));
      log(opts.out ? `Recording to ${opts.out} (Ctrl-C to stop)` : `Playing via ${playerName} (Ctrl-C to stop)`);
      return;
    }
    log(opts.json ? JSON.stringify(ev) : formatEvent(ev, sampleRate));
  });

  ws.addEventListener("error", (ev: Event) => {
    const e = ev as Event & { message?: string; error?: { message?: string; cause?: { message?: string } } };
    lastError = e.message || e.error?.cause?.message || e.error?.message || "";
  });

  ws.addEventListener("close", (ev: CloseEvent) => {
    if (!opened) {
      void (lastError ? Promise.resolve(lastError) : connectFailureReason(client)).then((why) =>
        finish(1, `could not connect to ${url}: ${why}`)
      );
      return;
    }
    const normal = ev.code === 1000 || ev.code === 1005;
    finish(
      normal ? 0 : 1,
      `connection closed by the server (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`
    );
  });

  return done;
}
