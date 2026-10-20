// Plugin config (plugins.entries["otacon-voice"].config), validated with
// defaults. Security follows the stock voice-call plugin: inbound calls only
// from allowFrom, calls bound to an agent and session, consult tool policy.

import { AGENT_CONTEXT_DEFAULTS, type AgentContextConfig } from "./context.js";
import type { SessionScope } from "./session.js";

export interface Contact {
  id: string;
  name: string;
  number: string;
  description?: string;
}

export type ToolPolicy = "safe-read-only" | "owner" | "none";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** A phone line on an otacon phone. */
export interface OtaconLineConfig {
  /** What the agent picks with otacon_call's `line` */
  id: string;
  provider: "otacon";
  /** Host base URL, e.g. https://otacon-pi.example.ts.net:8080 */
  url: string;
  /** Host phone id (e.g. phone-r5ct60sd), not the registry id */
  phoneId: string;
  /** Take control of the phone's voice socket from another client */
  takeover: boolean;
  /** The phone's number, for the agent (optional) */
  number?: string;
}

/** A phone line on a Twilio number. */
export interface TwilioLineConfig {
  id: string;
  provider: "twilio";
  accountSid: string;
  /** A string or a SecretRef */
  authToken: unknown;
  /** The Twilio number calls come from and go to (E.164) */
  fromNumber: string;
  /**
   * Where Twilio reaches this line's routes, which the gateway serves at
   * /otacon-voice/twilio/<id>: e.g. https://host.ts.net/otacon-voice/twilio/<id>
   */
  publicUrl: string;
  number: string;
}

export type LineConfig = OtaconLineConfig | TwilioLineConfig;

export interface OtaconVoiceConfig {
  enabled: boolean;
  lines: LineConfig[];
  /** The line calls go out on unless otacon_call names one (default: the first) */
  defaultLine: string;
  /**
   * Listen-in (otacon_listen): the only number a call may be played to,
   * and the line that dials it (default: the first line that can, a Twilio
   * line). Off without `to`.
   */
  listen?: { to: string; line?: string };
  /** Agent the calls belong to (default: the requester's, else "main") */
  agentId?: string;
  /**
   * The session a call runs in, as in the stock voice-call plugin: one per
   * phone number (default; calls with the same number share memory), one
   * per call, or the agent's main session. A caller of otacon_call can name
   * the session instead.
   */
  sessionScope: SessionScope;
  /** Who the assistant acts for, as said on calls */
  ownerName: string;
  assistantName: string;
  inboundPolicy: "disabled" | "allowlist";
  allowFrom: string[];
  /**
   * What the voice model includes in its first words when it answers an
   * incoming call, as voice-call's inboundGreeting (default "Hello! How can
   * I help you today?"; "" for no greeting: it waits for the caller).
   */
  inboundGreeting: string;
  /**
   * Session incoming calls belong to: their consults see its conversation and
   * the report goes there (default: agent:<agentId>:main). Set it to the
   * owner's chat when DMs get their own sessions (session.dmScope).
   */
  inboundSessionKey?: string;
  toolPolicy: ToolPolicy;
  consultPolicy: "auto" | "substantive" | "always";
  /** provider/model for consults (default: the agent's default model) */
  responseModel?: string;
  /** Thinking level for consults (default: the model's default) */
  consultThinkingLevel?: ThinkingLevel;
  /** Run consults in the provider's fast mode */
  consultFastMode?: boolean;
  responseTimeoutMs: number;
  realtime: {
    provider?: string;
    providers: Record<string, Record<string, unknown>>;
    /** Extra instructions appended to the built-in rules */
    instructions?: string;
    /** The agent's identity and workspace files in the voice model's instructions (context.ts) */
    agentContext: AgentContextConfig;
  };
  /** People the assistant may call during a call (hand-off) */
  contacts: Contact[];
  /** The phone-menu navigator on calls an agent places (navigator.ts) */
  menu: MenuConfig;
  /**
   * Longest hold before the phone-menu navigator hangs up and reports
   * (seconds). Holds after it hands off to the voice model aren't timed.
   */
  holdCapSeconds: number;
  maxCallSeconds: number;
  ringTimeoutSeconds: number;
}

const E164 = /^\+[1-9]\d{6,14}$/;

export interface MenuConfig {
  enabled: boolean;
  transcription: {
    /** OpenAI streaming speech-to-text model */
    model: string;
    /** gpt-live-transcribe's latency/accuracy trade-off */
    delay: "minimal" | "low" | "medium" | "high" | "xhigh";
    /** OpenAI API key (string or SecretRef; default: the realtime provider's) */
    apiKey?: unknown;
  };
  decisions: {
    /** OpenRouter decision model */
    model: string;
    /** OpenRouter API key (string or SecretRef) */
    apiKey?: unknown;
  };
  /** How often the navigator looks at new transcript (seconds) */
  checkEverySeconds: number;
  /**
   * Probability the navigator's chosen action (press, hand off, hang up) must
   * have; pressing also needs the key's. One decision, one threshold.
   */
  threshold: number;
}

const DELAYS = ["minimal", "low", "medium", "high", "xhigh"] as const;

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
  const lines: LineConfig[] = [];
  const rawLines = Array.isArray(c.lines) ? c.lines : [];
  if (!rawLines.length) errors.push("lines: at least one line is required");
  for (const [i, v] of rawLines.entries()) {
    const l = obj(v);
    const id = str(l.id);
    const where = `lines[${i}]${id ? ` (${id})` : ""}`;
    if (!id || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) errors.push(`${where}.id is required (letters, digits, - and _)`);
    else if (lines.some((x) => x.id === id)) errors.push(`${where}: duplicate id`);
    const number = str(l.number);
    if (number && !isE164(number)) errors.push(`${where}.number must be E.164`);
    if (l.provider === "otacon") {
      const url = str(l.url)?.replace(/\/+$/, "");
      const phoneId = str(l.phoneId);
      if (!url) errors.push(`${where}.url is required`);
      if (!phoneId) errors.push(`${where}.phoneId is required`);
      if (id && url && phoneId) lines.push({ id, provider: "otacon", url, phoneId, takeover: l.takeover === true, number });
    } else if (l.provider === "twilio") {
      const accountSid = str(l.accountSid);
      const fromNumber = str(l.fromNumber);
      const publicUrl = str(l.publicUrl)?.replace(/\/+$/, "");
      if (!accountSid) errors.push(`${where}.accountSid is required`);
      if (!l.authToken) errors.push(`${where}.authToken is required`);
      if (!isE164(fromNumber)) errors.push(`${where}.fromNumber must be E.164`);
      if (!publicUrl || !/^https:\/\//.test(publicUrl)) errors.push(`${where}.publicUrl must be an https URL`);
      if (id && accountSid && l.authToken && isE164(fromNumber) && publicUrl?.startsWith("https://"))
        lines.push({ id, provider: "twilio", accountSid, authToken: l.authToken, fromNumber, publicUrl, number: fromNumber });
    } else errors.push(`${where}.provider must be "otacon" or "twilio"`);
  }
  const defaultLine = str(c.defaultLine) ?? lines[0]?.id ?? "";
  if (lines.length && !lines.some((l) => l.id === defaultLine)) errors.push(`defaultLine: no line ${defaultLine}`);
  const listenRaw = obj(c.listen);
  let listen: OtaconVoiceConfig["listen"];
  if (c.listen !== undefined) {
    const to = str(listenRaw.to);
    const line = str(listenRaw.line);
    if (!isE164(to)) errors.push("listen.to must be E.164");
    // Only lines that can place an extra call while others are up.
    else if (line && lines.find((l) => l.id === line)?.provider !== "twilio") errors.push(`listen.line: ${line} isn't a Twilio line`);
    else if (!line && !lines.some((l) => l.provider === "twilio")) errors.push("listen needs a Twilio line to dial from");
    else listen = { to, line };
  }

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

  const menu = obj(c.menu);
  const transcription = obj(menu.transcription);
  const decisions = obj(menu.decisions);

  const realtime = obj(c.realtime);
  const agentContext = obj(realtime.agentContext);
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(obj(realtime.providers))) providers[k] = obj(v);
  // A configured model avoids the provider's GPT-Live default, which can't
  // run custom tools.
  providers.openai ??= {};
  providers.openai.model ??= "gpt-realtime-2.1";

  const inboundSessionKey = str(c.inboundSessionKey);
  if (inboundSessionKey && !inboundSessionKey.startsWith("agent:")) errors.push("inboundSessionKey must be a session key (agent:...)");

  if (c.consultThinkingLevel !== undefined && !THINKING_LEVELS.includes(c.consultThinkingLevel as ThinkingLevel))
    errors.push(`consultThinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);

  if (errors.length) return { errors };
  return {
    errors,
    config: {
      enabled: c.enabled !== false,
      lines,
      defaultLine,
      listen,
      agentId: str(c.agentId),
      sessionScope: oneOf(c.sessionScope, ["per-phone", "per-call", "main"] as const, "per-phone"),
      ownerName: str(c.ownerName) ?? "my principal",
      assistantName: str(c.assistantName) ?? "an AI assistant",
      inboundPolicy: oneOf(c.inboundPolicy, ["disabled", "allowlist"] as const, "disabled"),
      allowFrom,
      inboundGreeting: typeof c.inboundGreeting === "string" ? c.inboundGreeting.trim() : "Hello! How can I help you today?",
      inboundSessionKey,
      toolPolicy: oneOf(c.toolPolicy, ["safe-read-only", "owner", "none"] as const, "safe-read-only"),
      consultPolicy: oneOf(c.consultPolicy, ["auto", "substantive", "always"] as const, "auto"),
      responseModel: str(c.responseModel),
      consultThinkingLevel: c.consultThinkingLevel as ThinkingLevel | undefined,
      consultFastMode: typeof c.consultFastMode === "boolean" ? c.consultFastMode : undefined,
      responseTimeoutMs: num(c.responseTimeoutMs, 60_000, 5_000, 600_000),
      realtime: {
        provider: str(realtime.provider),
        providers,
        instructions: str(realtime.instructions),
        agentContext: {
          enabled: agentContext.enabled === true,
          includeIdentity: agentContext.includeIdentity !== false,
          includeWorkspaceFiles: agentContext.includeWorkspaceFiles !== false,
          files: Array.isArray(agentContext.files)
            ? agentContext.files.filter((f): f is string => typeof f === "string" && Boolean(f.trim()))
            : AGENT_CONTEXT_DEFAULTS.files,
          maxChars: Math.round(num(agentContext.maxChars, AGENT_CONTEXT_DEFAULTS.maxChars, 0, 50_000)),
        },
      },
      contacts,
      menu: {
        enabled: menu.enabled !== false,
        transcription: {
          model: str(transcription.model) ?? "gpt-live-transcribe",
          delay: oneOf(transcription.delay, DELAYS, "medium"),
          apiKey: transcription.apiKey,
        },
        decisions: { model: str(decisions.model) ?? "openai/gpt-6-luna-decisions", apiKey: decisions.apiKey },
        checkEverySeconds: num(menu.checkEverySeconds, 3, 1, 30),
        threshold: num(menu.threshold, 0.6, 0.5, 1),
      },
      holdCapSeconds: num(c.holdCapSeconds, 300, 10, 3600),
      maxCallSeconds: num(c.maxCallSeconds, 1800, 60, 4 * 3600),
      ringTimeoutSeconds: num(c.ringTimeoutSeconds, 45, 10, 120),
    },
  };
}
