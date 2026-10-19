import assert from "node:assert/strict";
import { test } from "node:test";
import { LineSound } from "../src/linesound.js";

/** Seconds of one sound, as 32 ms detector windows. */
function play(l: LineSound, sound: "speech" | "music" | "silence", seconds: number) {
  for (let i = 0; i < 31 * seconds; i++) l.window(sound === "speech" ? 0.9 : 0.02, sound === "silence" ? 0.0005 : 0.05);
}

test("each second is speech, music or silence", () => {
  const l = new LineSound(() => 0);
  // A sentence with pauses: 40% of the windows are speech.
  for (let i = 0; i < 31; i++) l.window(i % 5 < 2 ? 0.9 : 0.1, 0.05);
  play(l, "music", 1);
  play(l, "silence", 1);
  assert.deepEqual(
    l.runs().map((r) => r.sound),
    ["speech", "music", "silence"],
  );
});

test("a blip between two runs of one sound is folded into them", () => {
  const l = new LineSound(() => 0);
  play(l, "music", 10);
  play(l, "speech", 1);
  play(l, "music", 5);
  assert.deepEqual(l.runs(), [{ sound: "music", from: 0, to: 16 }]);
});

test("the hold counts from the first music or silence after the last key press, recorded messages included", () => {
  const l = new LineSound(() => 0);
  play(l, "speech", 10); // the menu; a key is pressed at 10 s
  play(l, "silence", 2); // the transfer: too short for a hold
  play(l, "speech", 4); // "Please hold"
  play(l, "music", 20);
  play(l, "speech", 6); // "Your call is important to us"
  play(l, "music", 10);
  const s = l.summary(10)!;
  assert.equal(s.now, "music");
  assert.equal(s.for_seconds, 10);
  assert.equal(s.seconds_on_hold, 36);
  assert.equal(l.quietSince(), 42);
  // A press during the hold starts it again.
  assert.equal(l.summary(40)!.seconds_on_hold, 10);
  play(l, "speech", 3);
  assert.equal(l.quietSince(), undefined);
  assert.equal(l.summary(10)!.now, "speech");
});

test("nothing heard yet: no summary", () => {
  assert.equal(new LineSound(() => 0).summary(), undefined);
});
