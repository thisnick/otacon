import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReport } from "../src/report.js";

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

test("report: the whole call log, timestamped, with events", () => {
  const text = formatReport({
    ...base,
    summary: "Booked for 2 at 7:30",
    log: [
      { t: 0, line: 1, kind: "event", text: "dialing +15550001111" },
      { t: 11_000, line: 1, kind: "event", text: "pressed 3" },
      { t: 224_000, line: 1, kind: "hear", who: "Luigi's", text: "How many people?" },
      { t: 230_500, line: 1, kind: "say", who: "assistant", text: "Two, at 7:30." },
    ],
  });
  assert.match(text, /placed to Luigi's \(\+15550001111\) from twilio \(\+15550009999\) has ended \(completed, 65s\)/);
  assert.match(text, /The assistant's note: Booked for 2 at 7:30/);
  assert.match(text, /\[00:11\] \[line 1\] — pressed 3/);
  assert.match(text, /\[03:44\] \[line 1\] Luigi's: How many people\?/);
  assert.match(text, /\[03:51\] \[line 1\] assistant: Two, at 7:30\./);
});

test("report: a very long call keeps its start and end", () => {
  const log = Array.from({ length: 2000 }, (_, i) => ({ t: i * 1000, kind: "hear" as const, who: "them", text: `line ${i} ${"x".repeat(40)}` }));
  const text = formatReport({ ...base, log });
  assert.ok(text.length < 32_000);
  assert.match(text, /line 0 /);
  assert.match(text, /line 1999 /);
  assert.match(text, /log entries omitted/);
});
