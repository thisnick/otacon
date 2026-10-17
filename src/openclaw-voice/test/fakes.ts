// Test doubles: an otacon link without a socket, a realtime SDK whose
// sessions record what they're sent, and a speech detector with a dial.

import type { BridgeSession } from "openclaw/plugin-sdk/realtime-voice";
import type { RealtimeSdk, SpeechDetectorLike } from "../src/call.js";
import { parseConfig, type OtaconVoiceConfig } from "../src/config.js";
import { OtaconLink, type OtaconCall } from "../src/otacon.js";

export const logger = { info() {}, warn() {}, error() {}, debug() {} };

export const tick = () => new Promise<void>((r) => setImmediate(r));

export async function settle(n = 5) {
  for (let i = 0; i < n; i++) await tick();
}

type Handler = (type: string, fields: Record<string, any>) => any;

/** OtaconLink with commands answered by `handler` and call events emitted by the test. */
export class FakeLink extends OtaconLink {
  cmds: { type: string; fields: Record<string, any> }[] = [];
  sent: Buffer[] = [];
  markCount = 0;
  clears = 0;
  handler: Handler = () => ({});

  constructor() {
    super({ url: "https://otacon.test:8080", phoneId: "phone-test", takeover: false, logger });
    this.open = true;
  }

  override start() {}
  override stop() {}

  override async cmd(type: string, fields: Record<string, any> = {}): Promise<any> {
    this.cmds.push({ type, fields });
    return this.handler(type, fields);
  }

  override sendAudio(pcm: Buffer) {
    this.sent.push(pcm);
  }

  override async mark(): Promise<boolean> {
    this.markCount++;
    return false;
  }

  override async clear(): Promise<number> {
    this.clears++;
    return 0;
  }

  types() {
    return this.cmds.map((c) => c.type);
  }

  /** Emit a call event, the way otacon's socket would. */
  call(type: "call.incoming" | "call.state" | "call.ended", call: Partial<OtaconCall> & { id: string }, reason?: string) {
    const full = {
      number: null,
      direction: "outgoing",
      state: "active",
      conference: false,
      startedAt: 0,
      ...this.calls.get(call.id),
      ...call,
    } as OtaconCall;
    if (type === "call.ended") this.calls.delete(call.id);
    else this.calls.set(call.id, full);
    this.emit("call", { type, call: full, reason });
  }
}

export class FakeSession implements BridgeSession {
  audioIn: Buffer[] = [];
  userMessages: string[] = [];
  toolResults: { callId: string; result: any; options?: { suppressResponse?: boolean } }[] = [];
  closed = false;

  constructor(public params: any) {}

  async connect() {}
  sendAudio(b: Buffer) {
    this.audioIn.push(b);
  }
  sendUserMessage(t: string) {
    this.userMessages.push(t);
  }
  submitToolResult(callId: string, result: unknown, options?: { suppressResponse?: boolean }) {
    this.toolResults.push({ callId, result, options });
  }
  handleBargeIn() {}
  acknowledgeMark() {}
  close() {
    this.closed = true;
  }

  /** The model calls a tool; resolves when the plugin has handled it. */
  async tool(name: string, args: Record<string, unknown> = {}) {
    await this.params.onToolCall({ name, args, callId: `${name}-${this.toolResults.length}` }, this);
    return this.toolResults[this.toolResults.length - 1];
  }

  /** The model speaks. */
  speak(pcm: Buffer) {
    this.params.audioSink.sendAudio(pcm, { itemId: "item-1" });
  }

  transcript(role: "user" | "assistant", text: string) {
    this.params.onTranscript(role, text, true);
  }
}

export function fakeSdk() {
  const sessions: FakeSession[] = [];
  const consults: Record<string, any>[] = [];
  const sdk: RealtimeSdk = {
    consultTool: { type: "function", name: "openclaw_agent_consult", description: "", parameters: { type: "object", properties: {} } },
    consultToolName: "openclaw_agent_consult",
    audioFormat: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
    resolveProvider: () => ({ provider: { id: "fake" }, providerConfig: {} }),
    createSession: (params) => {
      const s = new FakeSession(params);
      sessions.push(s);
      return s;
    },
    consult: async (p) => {
      consults.push(p);
      return { text: "Nick prefers 7:30." };
    },
    consultToolsAllow: () => undefined,
    resampler: () => ({ process: (b: Buffer) => b }),
  };
  return { sdk, sessions, consults };
}

/** A detector that reports `prob` for every 32 ms window (1024 bytes) pushed. */
export class FakeDetector implements SpeechDetectorLike {
  prob = 0;
  push(pcm: Buffer, onWindow: (p: number) => void) {
    for (let i = 0; i + 1024 <= pcm.length; i += 1024) onWindow(this.prob);
  }
}

export function config(extra: Record<string, unknown> = {}): OtaconVoiceConfig {
  const { config } = parseConfig({ otacon: { url: "https://otacon.test:8080", phoneId: "phone-test" }, ...extra });
  return config!;
}

export function fakeApi() {
  const events: { text: string; sessionKey: string }[] = [];
  const wakes: unknown[] = [];
  return {
    events,
    wakes,
    api: {
      id: "otacon-voice",
      rootDir: "/",
      registrationMode: "full",
      config: {},
      pluginConfig: {},
      logger,
      runtime: {
        agent: { defaults: { provider: "openai", model: "test-model" } },
        system: {
          enqueueSystemEvent: (text: string, o: { sessionKey: string }) => (events.push({ text, sessionKey: o.sessionKey }), true),
          requestHeartbeatNow: (o: unknown) => void wakes.push(o),
        },
      },
      registerTool() {},
      registerGatewayMethod() {},
      registerService() {},
    } as any,
  };
}

/** 32 ms of 16 kHz audio */
export const frame = (v = 1000) => Buffer.alloc(1024, v & 0xff);
