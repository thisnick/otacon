// The call outcome as the agent reads it, delivered to its session when a
// call ends: a TL;DR first, then as much of the call log (both sides,
// timestamped, with events) as fits. The whole log is saved too, and the
// agent reads it with otacon_call_log.

import type { LogEntry, MissionReport } from "./call.js";

/**
 * Longest report delivered to the agent's session. OpenClaw shows a stored
 * message to other sessions (sessions_history) cut at 4,000 characters, and
 * the message that carries the report holds more than the report, so the
 * TL;DR and the end of the call have to fit well under that.
 */
export const REPORT_MAX_CHARS = 3_000;

function stamp(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function formatLogEntry(e: LogEntry): string {
  const line = e.line ? `[line ${e.line}] ` : "";
  return e.kind === "event" ? `[${stamp(e.t)}] ${line}— ${e.text}` : `[${stamp(e.t)}] ${line}${e.who}: ${e.text}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export interface ReportOptions {
  /** Where the whole report was saved, if it was */
  savedAt?: string;
  /** Longest report; the log is cut to fit, keeping its end (default REPORT_MAX_CHARS) */
  maxChars?: number;
  /** The saved transcript itself: no pointer to it, no instruction to report back */
  saved?: boolean;
}

/**
 * The report. With a finite maxChars the TL;DR, goal and pointer to the full
 * transcript always come first, and the log keeps its most recent entries:
 * how a call ends is what the agent acts on.
 */
export function formatReport(r: MissionReport, o: ReportOptions = {}): string {
  const max = o.maxChars ?? REPORT_MAX_CHARS;
  const secs = Math.round((r.endedAt - r.startedAt) / 1000);
  const who = r.party.name === r.party.number ? r.party.number : `${r.party.name} (${r.party.number})`;
  // "[line 1]" in the log is a call leg; the phone line is named here.
  const ours = r.line ? `${r.line.id}${r.line.number ? ` (${r.line.number})` : ""}` : "";
  const head =
    r.direction === "outbound"
      ? `[otacon-voice] The phone call you placed to ${who}${ours ? ` from ${ours}` : ""} has ended (${r.outcome}, ${secs}s).`
      : `[otacon-voice] Incoming call from ${who}${ours ? ` to ${ours}` : ""} ended (${r.outcome}, ${secs}s).`;
  const tldr = r.summary?.trim()
    ? `TL;DR: ${clip(r.summary.trim(), 1_200)}`
    : "TL;DR: none; the call ended before the assistant summed it up. Read the log.";
  const full = o.saved ? "" : `Full transcript: otacon_call_log with callId ${r.missionId}${o.savedAt ? ` (saved at ${o.savedAt})` : ""}.`;
  const tail = o.saved ? "" : "Tell the user how the call went if they're waiting for it.";
  const session = `Call session (where its consults ran): ${r.sessionKey}`;
  const fixed = [head, tldr, full, session, tail];
  // The goal is the requester's own words, so it gives way first.
  const fixedChars = fixed.join("\n").length + 1;
  const goal = r.brief ? `Goal: ${clip(r.brief, Math.max(200, Math.floor((max - fixedChars) / 3)))}` : undefined;
  const out = [head, tldr];
  if (goal) out.push(goal);
  if (full) out.push(full);
  out.push(session);
  if (r.log.length) {
    const lines = r.log.map(formatLogEntry);
    const room = max - [...out, tail].join("\n").length - 2;
    let kept = lines;
    if (lines.join("\n").length + "Call log:".length + 1 > room) {
      kept = [];
      let used = 80; // the heading below
      for (let i = lines.length - 1; i >= 0 && used + lines[i].length + 1 <= room; i--) {
        kept.unshift(lines[i]);
        used += lines[i].length + 1;
      }
    }
    const omitted = lines.length - kept.length;
    out.push(
      omitted ? `Call log (the last ${kept.length} of ${lines.length} entries; the earlier ones are in otacon_call_log):` : "Call log:",
      ...kept,
    );
  }
  if (tail) out.push(tail);
  return out.join("\n");
}

/** The whole report, nothing cut: what is saved for otacon_call_log. */
export function formatSavedReport(r: MissionReport): string {
  return formatReport(r, { saved: true, maxChars: Number.POSITIVE_INFINITY });
}
