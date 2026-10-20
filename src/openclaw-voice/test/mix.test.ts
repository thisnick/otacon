import assert from "node:assert/strict";
import { test } from "node:test";
import { CallMix } from "../src/mix.js";

const pcm = (...v: number[]) => {
  const b = Buffer.alloc(v.length * 2);
  v.forEach((x, i) => b.writeInt16LE(x, i * 2));
  return b;
};
const values = (b: Buffer) => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));

test("mix: the line sets the pace; the model's audio queues until played; a barge-in drops it", () => {
  const m = new CallMix();
  assert.deepEqual(values(m.line(pcm(1, 2))), [1, 2], "nothing from the model yet");
  m.model(pcm(10, 20, 30)); // a burst, ahead of playback
  assert.deepEqual(values(m.line(pcm(1, 1))), [11, 21]);
  assert.deepEqual(values(m.line(pcm(1, 1))), [31, 1], "the rest, then the line alone");
  m.model(pcm(100, 100, 100));
  m.clear();
  assert.deepEqual(values(m.line(pcm(5))), [5], "cleared audio is never heard");
  m.model(pcm(32000));
  assert.deepEqual(values(m.line(pcm(32000))), [32767], "clipped, not wrapped");
});
