// The call outcome as the agent reads it, delivered to its session when a
// call ends.

import type { MissionReport } from "./call.js";

export function formatReport(r: MissionReport): string {
  const secs = Math.round((r.endedAt - r.startedAt) / 1000);
  const who = r.party.name === r.party.number ? r.party.number : `${r.party.name} (${r.party.number})`;
  const head =
    r.direction === "outbound"
      ? `[otacon-voice] The phone call you placed to ${who} has ended (${r.outcome}, ${secs}s).`
      : `[otacon-voice] Incoming call from ${who} ended (${r.outcome}, ${secs}s).`;
  const lines = [head];
  if (r.brief) lines.push(`Goal: ${r.brief}`);
  if (r.summary) lines.push(`Outcome: ${r.summary}`);
  if (r.transcript.length) {
    lines.push("Transcript:");
    for (const t of r.transcript.slice(-40)) lines.push(`  [line ${t.line}] ${t.who}: ${t.text}`);
  }
  lines.push("Let the user know how the call went if they're waiting for it.");
  return lines.join("\n");
}
