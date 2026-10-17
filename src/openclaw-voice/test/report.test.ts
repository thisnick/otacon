import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReport } from "../src/report.js";

test("report text", () => {
  const text = formatReport({
    missionId: "oc_1",
    direction: "outbound",
    party: { name: "+15550001111", number: "+15550001111", role: "primary" },
    brief: "Book a table",
    outcome: "completed",
    summary: "Booked for 2 at 7:30",
    transcript: [{ line: 1, who: "assistant", text: "Hi" }],
    startedAt: 0,
    endedAt: 65_000,
    agentId: "main",
  });
  assert.match(text, /placed to \+15550001111 has ended \(completed, 65s\)/);
  assert.match(text, /Outcome: Booked for 2 at 7:30/);
  assert.match(text, /\[line 1\] assistant: Hi/);
});
