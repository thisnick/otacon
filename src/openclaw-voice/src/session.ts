// Which OpenClaw session a call runs in (where its consults happen, so what
// the agent remembers of the call), decided the way the stock voice-call
// plugin decides it: an explicit key from whoever placed the call, else
// `sessionScope`.

export type SessionScope = "per-phone" | "per-call" | "main";

/** The routing helpers of the OpenClaw SDK this needs (realtime.ts); tests pass fakes. */
export interface SessionKeySdk {
  normalizeAgentId(id: string): string;
  parseAgentSessionKey(key: string): { agentId: string; rest: string } | null;
  canonicalizeMainSessionAlias(p: { cfg: unknown; agentId: string; sessionKey: string }): string;
}

/**
 * - explicit key: that session, in the call's agent's namespace
 * - "per-phone": agent:<agentId>:voice:<the other party's digits>, so calls
 *   with the same number share one session (the stock plugin's default and
 *   key format, so its earlier calls carry over)
 * - "per-call": agent:<agentId>:voice:call:<callId>
 * - "main": the agent's main session
 */
export function callSessionKey(
  sdk: SessionKeySdk,
  o: { cfg: any; agentId: string; scope: SessionScope; phone?: string | null; callId: string; explicit?: string },
): string {
  const explicit = o.explicit?.trim();
  if (explicit) return agentSessionKey(sdk, o.cfg, o.agentId, explicit);
  if (o.scope === "main") return agentSessionKey(sdk, o.cfg, o.agentId, "main");
  const prefix = `agent:${sdk.normalizeAgentId(o.agentId)}:voice`;
  if (o.scope === "per-call") return `${prefix}:call:${o.callId}`.toLowerCase();
  const phone = (o.phone ?? "").replace(/\D/g, "");
  return (phone ? `${prefix}:${phone}` : `${prefix}:${o.callId}`).toLowerCase();
}

/** `agent:<agentId>:...` keys as they are; any other key under the agent. */
function agentSessionKey(sdk: SessionKeySdk, cfg: any, agentIdRaw: string, key: string): string {
  const lower = key.toLowerCase();
  if (lower === "global" || lower === "unknown") return lower;
  const agentId = sdk.normalizeAgentId(agentIdRaw);
  const parsed = sdk.parseAgentSessionKey(key);
  let scoped: string;
  if (parsed && sdk.normalizeAgentId(parsed.agentId) === parsed.agentId && parsed.agentId === agentId) {
    scoped = `agent:${parsed.agentId}:${parsed.rest}`;
  } else {
    const wrapped = sdk.parseAgentSessionKey(`agent:${agentId}:${key}`);
    if (!wrapped) throw new Error(`session key "${key}" could not be normalized`);
    scoped = `agent:${agentId}:${wrapped.rest}`;
  }
  return sdk.canonicalizeMainSessionAlias({ cfg: { session: cfg?.session }, agentId, sessionKey: scoped });
}
