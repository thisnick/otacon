import assert from "node:assert/strict";
import { test } from "node:test";
import { types } from "node:util";
import { Worker } from "node:worker_threads";
import { withCloneableAudioFormat } from "../src/provider.js";

const PCM = { encoding: "pcm16", sampleRateHz: 24000, channels: 1 };

/** What GPT-Live's media socket does with the audio format: new Worker(url, { workerData: { ..., audioFormat } }). */
function mediaWorker(audioFormat: unknown) {
  return new Worker("", { eval: true, workerData: { url: "wss://127.0.0.1:1/", options: {}, model: "gpt-live-1", paced: true, audioFormat } });
}

test("withCloneableAudioFormat: a Worker takes the audio format; the rest of the request and the provider are as they were", async () => {
  const seen: { request: any; self: unknown }[] = [];
  const bridge = { close() {} };
  const provider = {
    id: "openai",
    model: "gpt-live-1",
    createBridge(request: unknown) {
      seen.push({ request, self: this });
      return bridge;
    },
  };
  const adapted = withCloneableAudioFormat(provider) as any;
  assert.equal(adapted.id, "openai");
  assert.equal(adapted.model, "gpt-live-1");

  // An owned view, as the SDK hands the request over inside a plugin instance.
  const cfg = { agents: {} };
  const onAudio = () => {};
  const tools = [{ type: "function", name: "end_call" }];
  const owned = new Proxy({ cfg, onAudio, tools, audioFormat: new Proxy({ ...PCM }, {}) }, {});
  assert.throws(() => mediaWorker(owned.audioFormat), { name: "DataCloneError" });

  assert.equal(adapted.createBridge(owned), bridge, "the provider's bridge comes back");
  const { request, self } = seen[0];
  assert.equal(self, provider, "createBridge runs on the provider");
  assert.deepEqual(request.audioFormat, PCM);
  assert.ok(!types.isProxy(request.audioFormat));
  await mediaWorker(request.audioFormat).terminate();
  assert.equal(request.cfg, cfg, "the config is passed on, not copied");
  assert.equal(request.onAudio, onAudio, "callbacks are passed on");
  assert.equal(request.tools, tools, "tools are passed on");

  // No audio format: the request goes through untouched.
  const bare = { cfg, onAudio };
  adapted.createBridge(bare);
  assert.equal(seen[1].request, bare);

  // A provider without createBridge is left alone.
  const other = { id: "other" };
  assert.equal(withCloneableAudioFormat(other), other);
});
