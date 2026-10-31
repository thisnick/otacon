import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReport, formatSavedReport, REPORT_MAX_CHARS } from "../src/report.js";

const base = {
  missionId: "oc_1",
  direction: "outbound" as const,
  party: { name: "Luigi's", number: "+15550001111", role: "primary" as const },
  brief: "Book a table",
  outcome: "completed" as const,
  startedAt: 0,
  endedAt: 65_000,
  sessionKey: "agent:main:voice:15550001111",
  agentId: "main",
  line: { id: "twilio", number: "+15550009999" },
};

const shortLog = [
  { t: 0, line: 1, kind: "event" as const, text: "dialing +15550001111" },
  { t: 11_000, line: 1, kind: "event" as const, text: "pressed 3" },
  { t: 224_000, line: 1, kind: "hear" as const, who: "Luigi's", text: "How many people?" },
  { t: 230_500, line: 1, kind: "say" as const, who: "assistant", text: "Two, at 7:30." },
];

/** A long call: entry i says "line i" and pads it out. */
const longLog = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ t: i * 1000, line: 1, kind: "hear" as const, who: "them", text: `line ${i} ${"x".repeat(40)}` }));

test("report: the TL;DR first, then the goal, where the full transcript is, and the log", () => {
  const text = formatReport({ ...base, summary: "Booked for 2 at 7:30", log: shortLog }, { savedAt: "/state/otacon-voice/calls/1970-01-01-oc_1.txt" });
  const lines = text.split("\n");
  assert.match(lines[0], /placed to Luigi's \(\+15550001111\) from twilio \(\+15550009999\) has ended \(completed, 65s\)/);
  assert.equal(lines[1], "TL;DR: Booked for 2 at 7:30");
  assert.equal(lines[2], "Goal: Book a table");
  assert.match(lines[3], /^Full transcript: otacon_call_log with callId oc_1 \(saved at \/state\/otacon-voice\/calls\/1970-01-01-oc_1\.txt\)\.$/);
  assert.match(text, /\nCall log:\n/);
  assert.match(text, /\[00:11\] \[line 1\] — pressed 3/);
  assert.match(text, /\[03:44\] \[line 1\] Luigi's: How many people\?/);
  assert.match(text, /\[03:51\] \[line 1\] assistant: Two, at 7:30\./);
  assert.match(text, /Tell the user how the call went/);
});

test("report: without the assistant's summary, the TL;DR says so", () => {
  const text = formatReport({ ...base, log: shortLog });
  assert.match(text.split("\n")[1], /^TL;DR: none; the call ended before the assistant summed it up/);
});

test("report: a long call fits the limit and keeps the TL;DR and the end of the call", () => {
  const text = formatReport({ ...base, summary: "They said yes", log: longLog(300) });
  assert.ok(text.length <= REPORT_MAX_CHARS, `${text.length} chars`);
  assert.match(text, /TL;DR: They said yes/);
  assert.match(text, /line 299 /, "the last thing said");
  assert.doesNotMatch(text, /line 0 /);
  assert.match(text, /Call log \(the last \d+ of 300 entries; the earlier ones are in otacon_call_log\):/);
  assert.match(text, /Tell the user how the call went/);
});

test("report: a very long goal gives way; the TL;DR and pointer stay", () => {
  const text = formatReport({ ...base, brief: "b".repeat(10_000), summary: "Done", log: longLog(50) });
  assert.ok(text.length <= REPORT_MAX_CHARS, `${text.length} chars`);
  assert.match(text, /TL;DR: Done/);
  assert.match(text, /Goal: b+…/);
  assert.match(text, /otacon_call_log with callId oc_1/);
  assert.match(text, /line 49 /);
});

test("saved report: everything, without a pointer to itself or an instruction", () => {
  const text = formatSavedReport({ ...base, summary: "They said yes", log: longLog(2000) });
  assert.match(text, /TL;DR: They said yes/);
  assert.match(text, /line 0 /);
  assert.match(text, /line 1999 /);
  assert.match(text, /\nCall log:\n/);
  assert.doesNotMatch(text, /otacon_call_log|Tell the user/);
});
