// A call's realtime session on the real OpenClaw plugin SDK, started the way
// runtime.ts starts it: in a managed plugin instance's background context.
//
// Since OpenClaw 2026.11.1 the SDK hands the provider a lifecycle-owned view
// of the bridge request (a Proxy) in that context, and GPT-Live's
// gateway-relay transport puts the request's audioFormat in a Worker's
// workerData, which can't clone a Proxy. Fakes can't show that, so this
// needs an OpenClaw install: OPENCLAW_TEST_SDK_ROOT=<.../node_modules/openclaw>,
// or one under this package's node_modules. Skipped without one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types } from "node:util";
import { Worker } from "node:worker_threads";
import { CallMission, type MissionReport } from "../src/call.js";
import { config, fakeApi, fakeSdk, FakeDetector, FakeLink, settle } from "./fakes.js";

const packageRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const sdkRoot = process.env.OPENCLAW_TEST_SDK_ROOT ?? join(packageRoot, "node_modules/openclaw");
const skip = existsSync(join(sdkRoot, "package.json")) ? false : "no OpenClaw SDK: set OPENCLAW_TEST_SDK_ROOT";

const PCM = { encoding: "pcm16", sampleRateHz: 24000, channels: 1 };

const realtimeVoice = () => import(pathToFileURL(join(sdkRoot, "dist/plugin-sdk/realtime-voice.js")).href);

/** What GPT-Live's media socket does with the audio format: new Worker(url, { workerData: { ..., audioFormat } }). */
function mediaWorker(audioFormat: unknown) {
  return new Worker("", { eval: true, workerData: { url: "wss://127.0.0.1:1/", options: {}, model: "gpt-live-1", paced: true, audioFormat } });
}

/**
 * A managed plugin instance, as the gateway makes for each loaded plugin
 * (api.lifecycle is its lifecycle). The class is internal to the SDK's
 * bundle: it's taken from the module that bundles plugin-instance.ts.
 */
async function managedPluginInstance(id: string): Promise<any> {
  const dist = join(sdkRoot, "dist");
  const names = (await readdir(dist)).filter((f) => f.endsWith(".mjs"));
  for (const f of [...names.filter((n) => n.startsWith("plugin-setup-module")), ...names]) {
    const text = await readFile(join(dist, f), "utf8");
    if (!text.includes("//#region src/plugins/plugin-instance.ts")) continue;
    const exported = /\bPluginInstance as ([\w$]+)/.exec(text)?.[1];
    assert.ok(exported, `${f} bundles PluginInstance but doesn't export it`);
    const PluginInstance = (await import(pathToFileURL(join(dist, f)).href))[exported];
    return new PluginInstance(id);
  }
  throw new Error(`no module in ${dist} bundles src/plugins/plugin-instance.ts; the SDK moved it, update this test`);
}

/** A GPT-Live-shaped provider: the request's audio format goes to a Worker, as in OpenAI's gateway-relay transport. */
function fakeProvider() {
  const seen = { request: undefined as any, workers: [] as Worker[], workerError: undefined as unknown, results: [] as { callId: string; result: unknown }[], closed: 0 };
  const provider = {
    id: "openai",
    createBridge(request: any) {
      seen.request = request;
      try {
        seen.workers.push(mediaWorker(request.audioFormat));
      } catch (err) {
        seen.workerError = err;
        throw err;
      }
      let connected = false;
      return {
        outputAudioMode: "continuous",
        connect: async () => {
          connected = true;
          request.onReady();
        },
        isConnected: () => connected,
        sendAudio() {},
        sendUserMessage() {},
        setMediaTimestamp() {},
        acknowledgeMark() {},
        handleBargeIn() {},
        submitToolResult(callId: string, result: unknown) {
          seen.results.push({ callId, result });
        },
        close() {
          connected = false;
          seen.closed++;
          for (const w of seen.workers) void w.terminate();
        },
      };
    },
  };
  return { provider, seen };
}

/** An outbound call, answered, with its model session on the real SDK. */
async function startCall(voice: any, live: boolean) {
  const { provider, seen } = fakeProvider();
  const { sdk, consults } = fakeSdk();
  sdk.audioFormat = voice.REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ;
  sdk.createSession = voice.createRealtimeVoiceBridgeSession;
  sdk.consultTool = voice.REALTIME_VOICE_AGENT_CONSULT_TOOL;
  sdk.consultToolName = voice.REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME;
  sdk.resolveProvider = (() => ({
    provider,
    providerConfig: {},
    capabilities: live ? { handlesAgentConsult: true, supportsToolCalls: false } : { supportsToolCalls: true },
  })) as any;
  const link = new FakeLink();
  link.handler = (type, f) => {
    if (type === "dial") {
      link.call("call.state", { id: "c1", number: f.to, state: "dialing" });
      return { call: link.calls.get("c1") };
    }
    return {};
  };
  const { api } = fakeApi();
  api.config = { agents: { list: [{ id: "main" }] } };
  const reports: MissionReport[] = [];
  const m = new CallMission({
    api,
    config: config({ holdCapSeconds: 60, ringTimeoutSeconds: 20 }),
    link,
    line: { id: "sim" },
    sdk,
    detector: new FakeDetector(),
    direction: "outbound",
    party: { name: "Bright Smile Dental", number: "+15555550100", role: "primary" },
    brief: "Move the cleaning to Thursday 2 PM",
    contacts: [],
    agentId: "main",
    requesterSessionKey: "agent:main:main",
    onEnd: (r) => reports.push(r),
  });
  const instance = await managedPluginInstance("otacon-voice");
  // runtime.ts: a call runs in the plugin's background context.
  instance.lifecycle.runInBackgroundContext(() => m.start());
  await settle();
  link.call("call.state", { id: "c1", state: "active" });
  for (let i = 0; i < 200 && !seen.request; i++) await settle();
  assert.ok(seen.request, "the provider got the session request");
  return { m, link, api, seen, consults, reports };
}

test("the SDK hands a provider in a managed plugin instance an owned view that a Worker can't take", { skip }, async () => {
  const voice = await realtimeVoice();
  const instance = await managedPluginInstance("otacon-voice");
  let request: any;
  const provider = {
    id: "openai",
    createBridge(r: any) {
      request = r;
      return { outputAudioMode: "continuous", connect: async () => {}, isConnected: () => false, sendAudio() {}, sendUserMessage() {}, setMediaTimestamp() {}, acknowledgeMark() {}, submitToolResult() {}, close() {} };
    },
  };
  const params = { provider, providerConfig: {}, capabilities: {}, cfg: {}, agentId: "main", audioFormat: voice.REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ, instructions: "", tools: [], audioSink: { sendAudio() {} } };
  // Outside a plugin instance: the SDK's plain request.
  voice.createRealtimeVoiceBridgeSession(params);
  assert.ok(!types.isProxy(request.audioFormat));
  await mediaWorker(request.audioFormat).terminate();
  // Inside one: an owned view, a Proxy down to the audio format, which is what call.ts has to pass on.
  await instance.lifecycle.runInBackgroundContext(() => voice.createRealtimeVoiceBridgeSession(params));
  assert.ok(types.isProxy(request), "the SDK wraps the request for the plugin instance");
  assert.ok(types.isProxy(request.audioFormat));
  assert.throws(() => mediaWorker(request.audioFormat), { name: "DataCloneError" });
});

test("a call on the real SDK: GPT-Live's Worker takes the audio format; config, callbacks, tools and consults stay the SDK's", { skip }, async () => {
  const voice = await realtimeVoice();

  // GPT-Live: the audio format reaches the media Worker; the model gets no tools.
  const live = await startCall(voice, true);
  assert.ifError(live.seen.workerError);
  assert.equal(live.seen.workers.length, 1, "the media Worker started");
  assert.deepEqual(live.seen.request.audioFormat, PCM);
  assert.ok(!types.isProxy(live.seen.request.audioFormat));
  assert.equal(live.seen.request.tools.length, 0);
  assert.ok(types.isProxy(live.seen.request.cfg), "the config is still the SDK's owned view, not a copy");
  assert.deepEqual(JSON.parse(JSON.stringify(live.seen.request.cfg)), live.api.config);
  // The SDK's own callbacks: model audio reaches the phone through its gate.
  live.seen.request.onAudio(Buffer.alloc(960, 0x40));
  assert.equal(live.link.sent.length, 1);
  await live.m.finish("ended_by_agent");
  assert.equal(live.seen.closed, 1, "the bridge closed with the call");
  assert.equal(live.reports[0]?.outcome, "ended_by_agent");

  // Realtime models: the same request with the call's tools; a consult round-trips.
  const rt = await startCall(voice, false);
  assert.deepEqual(Array.from(rt.seen.request.tools, (t: any) => t.name), ["send_dtmf", "end_call", voice.REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME]);
  rt.seen.request.onToolCall({ callId: "t1", name: voice.REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, args: { question: "When does Nick prefer?" } });
  for (let i = 0; i < 100 && !rt.seen.results.length; i++) await settle();
  assert.equal(rt.consults.length, 1, "the consult ran");
  assert.deepEqual(rt.seen.results.at(-1), { callId: "t1", result: { text: "Nick prefers 7:30." } });
  await rt.m.finish("ended_by_agent");
  assert.equal(rt.seen.closed, 1);
});
