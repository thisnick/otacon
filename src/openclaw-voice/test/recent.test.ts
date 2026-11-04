import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSessionText, earlierCallFromSaved, formatConsultContext, formatRecentContext, isOwnerNumber } from "../src/recent.js";

const SAVED = [
  "[otacon-voice] The phone call you placed to Luigi's (+15555550100) from sim (+15555550199) has ended (completed, 75s).",
  "TL;DR: Table for two booked for Friday 7:30.",
  "Goal: Book a table",
  "Call log:",
  "[00:02] Luigi's: Luigi's, how can I help?",
  "[00:05] [line 1] — the line rang",
  "[00:09] Nick's assistant: A table for two on Friday, please.",
].join("\n");

test("a saved report reads back as an earlier call of its party only", () => {
  assert.deepEqual(earlierCallFromSaved(SAVED, 1000, "+15555550100"), {
    endedAt: 1000,
    seconds: 75,
    direction: "outbound",
    summary: "Table for two booked for Friday 7:30.",
    lastLines: ["Luigi's: Luigi's, how can I help?", "Nick's assistant: A table for two on Friday, please."],
  });
  assert.equal(earlierCallFromSaved(SAVED, 1000, "+15555550199"), undefined, "our own line's number is not the party");
  const untold = SAVED.replace(/TL;DR: .*/, "TL;DR: none; the call ended before the assistant summed it up. Read the log.");
  assert.equal(earlierCallFromSaved(untold, 1000, "+15555550100")!.summary, undefined);
});

test("only the owner's numbers in commands.ownerAllowFrom count as the owner", () => {
  const cfg = { commands: { ownerAllowFrom: ["whatsapp:+15555550102", "telegram:15555550103", "+15555550104"] } };
  assert.equal(isOwnerNumber(cfg, "+15555550102"), true);
  assert.equal(isOwnerNumber(cfg, "+15555550104"), true);
  assert.equal(isOwnerNumber(cfg, "+15555550103"), false);
  assert.equal(isOwnerNumber(cfg, "15555550102"), false);
  assert.equal(isOwnerNumber({}, "+15555550102"), false);
});

test("session messages lose OpenClaw's metadata blocks", () => {
  const text = 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"a":1}\n```\n\nSender (untrusted metadata):\n```json\n{"b":2}\n```\n\nCall me back at 5';
  assert.equal(cleanSessionText(text), "Call me back at 5");
});

test("the recap keeps the newest messages that fit", () => {
  const now = 10 * 86_400_000;
  assert.equal(formatRecentContext({ calls: [], messages: [], ownerName: "Nick", now }), undefined);
  const messages = Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, text: `${i} ${"x".repeat(290)}`, timestamp: now - (30 - i) * 60_000 }));
  const text = formatRecentContext({ calls: [{ endedAt: now - 86_400_000, seconds: 30, direction: "inbound", lastLines: [] }], messages, ownerName: "Nick", now })!;
  assert.ok(text.length <= 3000);
  assert.match(text, /- yesterday, they called \(30 s\)\n/);
  assert.match(text, /Nick: 29 x+$/);
  assert.doesNotMatch(text, /Nick: 0 x/);
});

test("the consult context keeps the owner's newest messages that fit", () => {
  const now = 10 * 86_400_000;
  assert.equal(formatConsultContext({ messages: [{ role: "user", text: "   " }], ownerName: "Nick", now }), undefined);
  const messages = Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `${i} ${"z".repeat(290)}`, timestamp: now - (30 - i) * 60_000 }));
  const text = formatConsultContext({ messages, ownerName: "Nick", now })!;
  assert.ok(text.length <= 3000);
  assert.match(text, /^Your latest messages with Nick, oldest first, for context:\n/);
  assert.match(text, /- \(1 min ago\) You: 29 z+$/);
  assert.doesNotMatch(text, /: 0 z/);
});
