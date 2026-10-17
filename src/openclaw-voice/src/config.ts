// Plugin config (plugins.entries["otacon-voice"].config), validated with
// defaults. Security follows the stock voice-call plugin: inbound calls only
// from allowFrom, calls bound to an agent and session, consult tool policy.

export interface Contact {
  id: string;
  name: string;
  number: string;
  description?: string;
}

export type ToolPolicy = "safe-read-only" | "owner" | "none";

export interface OtaconVoiceConfig {
  enabled: boolean;
  otacon: {
    /** Host base URL, e.g. https://otacon-pi.example.ts.net:8080 */
    url: string;
    /** Host phone id (e.g. phone-r5ct60sd), not the registry id */
    phoneId: string;
    /** Take control of the phone's voice socket from another client */
    takeover: boolean;
  };
  /** Agent the calls belong to (default: the requester's, else "main") */
  agentId?: string;
  /** Who the assistant acts for, as said on calls */
  ownerName: string;
  assistantName: string;
  inboundPolicy: "disabled" | "allowlist";
  allowFrom: string[];
  toolPolicy: ToolPolicy;
  consultPolicy: "auto" | "substantive" | "always";
  /** provider/model for consults (default: the agent's default model) */
  responseModel?: string;
  responseTimeoutMs: number;
  realtime: {
    provider?: string;
    providers: Record<string, Record<string, unknown>>;
    /** Extra instructions appended to the built-in rules */
    instructions?: string;
  };
  /** People the assistant may call during a call (hand-off) */
  contacts: Contact[];
  /** Longest wait on hold before hanging up and reporting (seconds) */
  holdCapSeconds: number;
  maxCallSeconds: number;
  ringTimeoutSeconds: number;
}

const E164 = /^\+[1-9]\d{6,14}$/;

export function isE164(n: unknown): n is string {
  return typeof n === "string" && E164.test(n);
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown, def: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return allowed.includes(v as T) ? (v as T) : def;
}

export function parseConfig(raw: unknown): { config?: OtaconVoiceConfig; errors: string[] } {
  const c = obj(raw);
  const errors: string[] = [];
  const otacon = obj(c.otacon);
  const url = str(otacon.url)?.replace(/\/+$/, "");
  const phoneId = str(otacon.phoneId);
  if (!url) errors.push("otacon.url is required");
  if (!phoneId) errors.push("otacon.phoneId is required");

  const allowFrom = Array.isArray(c.allowFrom) ? c.allowFrom.filter((n) => typeof n === "string") : [];
  for (const n of allowFrom) if (!isE164(n)) errors.push(`allowFrom: ${n} is not E.164`);

  const contacts: Contact[] = [];
  for (const [id, v] of Object.entries(obj(c.contacts))) {
    const e = obj(v);
    const number = str(e.number);
    if (!isE164(number)) {
      errors.push(`contacts.${id}.number must be E.164`);
      continue;
    }
    contacts.push({ id, name: str(e.name) ?? id, number, description: str(e.description) });
  }

  const realtime = obj(c.realtime);
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(obj(realtime.providers))) providers[k] = obj(v);
  // A configured model avoids the provider's GPT-Live default, which can't
  // run custom tools.
  providers.openai ??= {};
  providers.openai.model ??= "gpt-realtime-2.1";

  if (errors.length) return { errors };
  return {
    errors,
    config: {
      enabled: c.enabled !== false,
      otacon: { url: url!, phoneId: phoneId!, takeover: otacon.takeover === true },
      agentId: str(c.agentId),
      ownerName: str(c.ownerName) ?? "my principal",
      assistantName: str(c.assistantName) ?? "an AI assistant",
      inboundPolicy: oneOf(c.inboundPolicy, ["disabled", "allowlist"] as const, "disabled"),
      allowFrom,
      toolPolicy: oneOf(c.toolPolicy, ["safe-read-only", "owner", "none"] as const, "safe-read-only"),
      consultPolicy: oneOf(c.consultPolicy, ["auto", "substantive", "always"] as const, "auto"),
      responseModel: str(c.responseModel),
      responseTimeoutMs: num(c.responseTimeoutMs, 60_000, 5_000, 600_000),
      realtime: { provider: str(realtime.provider), providers, instructions: str(realtime.instructions) },
      contacts,
      holdCapSeconds: num(c.holdCapSeconds, 300, 10, 3600),
      maxCallSeconds: num(c.maxCallSeconds, 1800, 60, 4 * 3600),
      ringTimeoutSeconds: num(c.ringTimeoutSeconds, 45, 10, 120),
    },
  };
}
