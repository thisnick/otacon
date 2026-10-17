// The call outcome as the agent reads it, delivered to its session when a
// call ends: the whole call log (both sides, timestamped, with events), so
// the agent can summarize and act on it itself.

import type { LogEntry, MissionReport } from "./call.js";

/** Longest log text sent; beyond it the middle of the call is elided. */
const MAX_LOG_CHARS = 30_000;

function stamp(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function formatLogEntry(e: LogEntry): string {
  const line = e.line ? `[line ${e.line}] ` : "";
  return e.kind === "event" ? `[${stamp(e.t)}] ${line}— ${e.text}` : `[${stamp(e.t)}] ${line}${e.who}: ${e.text}`;
}

export function formatReport(r: MissionReport): string {
  const secs = Math.round((r.endedAt - r.startedAt) / 1000);
  const who = r.party.name === r.party.number ? r.party.number : `${r.party.name} (${r.party.number})`;
  const head =
    r.direction === "outbound"
      ? `[otacon-voice] The phone call you placed to ${who} has ended (${r.outcome}, ${secs}s).`
      : `[otacon-voice] Incoming call from ${who} ended (${r.outcome}, ${secs}s).`;
  const out = [head];
  if (r.brief) out.push(`Goal: ${r.brief}`);
  if (r.summary) out.push(`The assistant's note: ${r.summary}`);
  if (r.log.length) {
    let lines = r.log.map(formatLogEntry);
    let text = lines.join("\n");
    if (text.length > MAX_LOG_CHARS) {
      // Keep the start and the end of a very long call.
      const head = [];
      let used = 0;
      while (used < MAX_LOG_CHARS / 3 && lines.length) used += (head.push(lines.shift()!), head[head.length - 1].length + 1);
      const tail = [];
      used = 0;
      while (used < (MAX_LOG_CHARS * 2) / 3 && lines.length) used += (tail.unshift(lines.pop()!), tail[0].length + 1);
      lines = [...head, `… (${lines.length} log entries omitted) …`, ...tail];
      text = lines.join("\n");
    }
    out.push("Call log:", text);
  }
  out.push("Tell the user how the call went if they're waiting for it.");
  return out.join("\n");
}
