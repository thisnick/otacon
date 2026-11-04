// Recent context for the voice model at the start of a call: how earlier
// calls with the same number went, and, when the caller is the owner, the
// latest messages of the session the call reports to. Without it the voice
// model starts every call knowing nothing of the last one.

import type { MissionReport } from "./call.js";
import { formatLogEntry } from "./report.js";

/** An earlier call with the number, as the recap shows it. */
export interface EarlierCall {
  endedAt: number;
  seconds: number;
  direction: "inbound" | "outbound";
  /** The assistant's TL;DR, when it ended the call itself */
  summary?: string;
  /** The last few things said, for calls without a TL;DR */
  lastLines: string[];
}

/** A message of the owner's session, as the SDK reads it. */
export interface SessionText {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
}

const LAST_LINES = 4;
const MAX_LINE_CHARS = 200;
const MAX_MESSAGE_CHARS = 300;
const MAX_CONTEXT_CHARS = 3_000;
const NO_TLDR = /^none; the call ended before/;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…`;
}

export function earlierCallFromReport(r: MissionReport): EarlierCall {
  const said = r.log.filter((e) => e.kind !== "event").slice(-LAST_LINES);
  return {
    endedAt: r.endedAt,
    seconds: Math.round((r.endedAt - r.startedAt) / 1000),
    direction: r.direction,
    summary: r.summary?.trim() || undefined,
    lastLines: said.map((e) => clip(formatLogEntry(e).replace(/^\[[^\]]*\] (?:\[line \d+\] )?/, ""), MAX_LINE_CHARS)),
  };
}

/**
 * An earlier call read back from its saved report (report.ts), when the
 * report's party is `number`; the report's first number is the party's.
 */
export function earlierCallFromSaved(text: string, savedAtMs: number, number: string): EarlierCall | undefined {
  const lines = text.split("\n");
  const head = lines[0] ?? "";
  if (head.match(/\+\d{7,15}/)?.[0] !== number) return undefined;
  const ended = head.match(/ended \([^,]+, (\d+)s\)\.$/);
  const tldr = lines.find((l) => l.startsWith("TL;DR: "))?.slice(7).trim();
  // Log lines, not events ("[00:05] [line 1] — the line rang").
  const said = lines.filter((l) => /^\[\d+:\d\d\] (?!(?:\[line \d+\] )?—)/.test(l)).slice(-LAST_LINES);
  return {
    endedAt: savedAtMs,
    seconds: ended ? Number(ended[1]) : 0,
    direction: head.startsWith("[otacon-voice] Incoming call") ? "inbound" : "outbound",
    summary: tldr && !NO_TLDR.test(tldr) ? tldr : undefined,
    lastLines: said.map((l) => clip(l.replace(/^\[[^\]]*\] (?:\[line \d+\] )?/, ""), MAX_LINE_CHARS)),
  };
}

/** Whether a phone number is one of the owner's identities in commands.ownerAllowFrom. */
export function isOwnerNumber(cfg: unknown, number: string): boolean {
  if (!/^\+\d{7,15}$/.test(number)) return false;
  const entries = (cfg as { commands?: { ownerAllowFrom?: unknown } } | undefined)?.commands?.ownerAllowFrom;
  return Array.isArray(entries) && entries.some((e) => typeof e === "string" && (e === number || e.endsWith(`:${number}`)));
}

/** A session message without OpenClaw's metadata blocks. */
export function cleanSessionText(text: string): string {
  return clip(
    text
      .replace(/^.*(?:⟦openclaw:ctx⟧|\(untrusted metadata\)).*\n```[a-z]*\n[\s\S]*?\n```/gm, "")
      .replace(/^.*⟦openclaw:ctx⟧.*$/gm, ""),
    MAX_MESSAGE_CHARS,
  );
}

function ago(ms: number, now: number): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function duration(seconds: number): string {
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function messageLines(messages: SessionText[], ownerName: string, now: number): string[] {
  return messages.flatMap((m) => {
    const text = cleanSessionText(m.text);
    if (!text) return [];
    const when = m.timestamp ? `(${ago(m.timestamp, now)}) ` : "";
    return [`- ${when}${m.role === "user" ? ownerName : "You"}: ${text}`];
  });
}

/** The owner's latest messages for a call's first consult, oldest first, as many as fit. */
export function formatConsultContext(o: { messages: SessionText[]; ownerName: string; now: number }): string | undefined {
  const chat = messageLines(o.messages, o.ownerName, o.now);
  if (!chat.length) return undefined;
  const build = () => `Your latest messages with ${o.ownerName}, oldest first, for context:\n${chat.join("\n")}`;
  let text = build();
  while (text.length > MAX_CONTEXT_CHARS && chat.length > 1) {
    chat.shift();
    text = build();
  }
  return text.slice(0, MAX_CONTEXT_CHARS);
}

/**
 * The recent-context section of the voice instructions. `calls` is newest
 * first; `messages` oldest first, as the SDK returns them.
 */
export function formatRecentContext(o: { calls: EarlierCall[]; messages: SessionText[]; ownerName: string; now: number }): string | undefined {
  const calls = o.calls.map((c) => {
    const when = `${ago(c.endedAt, o.now)}, ${c.direction === "inbound" ? "they called" : "you called them"} (${duration(c.seconds)})`;
    if (c.summary) return `- ${when}: ${clip(c.summary, 600)}`;
    return c.lastLines.length ? `- ${when}; it ended with:\n${c.lastLines.map((l) => `    ${l}`).join("\n")}` : `- ${when}`;
  });
  const chat = messageLines(o.messages, o.ownerName, o.now);
  if (!calls.length && !chat.length) return undefined;
  const build = () =>
    [
      "Recent context with this caller, for continuity. Use it when it helps; don't read it out, and it may be out of date.",
      ...(calls.length ? [`Earlier calls with this number, newest first:\n${calls.join("\n")}`] : []),
      ...(chat.length ? [`Your latest messages with ${o.ownerName}, oldest first:\n${chat.join("\n")}`] : []),
    ].join("\n\n");
  let text = build();
  // Keep the newest messages when the whole does not fit.
  while (text.length > MAX_CONTEXT_CHARS && chat.length) {
    chat.shift();
    text = build();
  }
  return text.slice(0, MAX_CONTEXT_CHARS);
}
