// The agent's voice context, built as the stock voice-call plugin builds it
// (realtime.agentContext): the agent's configured identity and a few
// workspace files (SOUL.md, IDENTITY.md and USER.md by default), added to the
// voice model's instructions so it knows who it is and who it works for.

export interface AgentContextConfig {
  enabled: boolean;
  /** The agent's configured identity fields (name, emoji, vibe, theme, persona) */
  includeIdentity: boolean;
  includeWorkspaceFiles: boolean;
  /** Workspace-relative files, read in order until maxChars */
  files: string[];
  maxChars: number;
}

export const AGENT_CONTEXT_DEFAULTS: AgentContextConfig = {
  enabled: false,
  includeIdentity: true,
  includeWorkspaceFiles: true,
  files: ["SOUL.md", "IDENTITY.md", "USER.md"],
  maxChars: 6000,
};

/** The SDK helpers this needs (realtime.ts); tests pass fakes. */
export interface AgentContextSdk {
  resolveAgentIdentity(cfg: unknown, agentId: string): unknown;
  resolveAgentWorkspaceDir(cfg: unknown, agentId: string): string;
  /** Reads inside the workspace only */
  workspaceRoot(dir: string): Promise<{ readText(file: string): Promise<string> }>;
}

function limit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, Math.max(0, maxChars - 32)).trimEnd();
  // Don't end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}\n[truncated]`.slice(0, maxChars);
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function buildAgentContext(
  sdk: AgentContextSdk,
  o: { config: AgentContextConfig; cfg: unknown; agentId: string; consultToolName: string },
): Promise<string | undefined> {
  const { config } = o;
  if (!config.enabled) return undefined;
  const capsule = [
    "OpenClaw agent voice context:",
    `- Agent id: ${o.agentId}`,
    "- Use this context to match the OpenClaw agent's personality and standing preferences on fast voice turns.",
    `- Treat this as compact context only; call ${o.consultToolName} when the caller needs the full agent brain, tools, memory, or workspace state.`,
  ];
  if (config.includeIdentity) {
    const identity = (sdk.resolveAgentIdentity(o.cfg, o.agentId) ?? {}) as Record<string, unknown>;
    const lines = (
      [
        ["Name", identity.name],
        ["Emoji", identity.emoji],
        ["Vibe", identity.vibe],
        ["Theme", identity.theme],
        ["Creature/persona", identity.creature],
      ] as const
    ).flatMap(([label, value]) => (str(value) ? [`- ${label}: ${str(value)}`] : []));
    if (lines.length) capsule.push(`Configured identity:\n${lines.join("\n")}`);
  }
  if (config.includeWorkspaceFiles) {
    const workspace = await sdk.workspaceRoot(sdk.resolveAgentWorkspaceDir(o.cfg, o.agentId)).catch(() => null);
    if (workspace) {
      const sections: string[] = [];
      let remaining = config.maxChars;
      for (const file of config.files) {
        if (remaining <= 0) continue;
        const text = (await workspace.readText(file).catch(() => undefined))?.trim();
        if (!text) continue;
        const section = `### ${file}\n${limit(text, Math.max(0, remaining - file.length - 16))}`;
        sections.push(section);
        remaining -= section.length;
      }
      if (sections.length) capsule.push(`Workspace voice context:\n${sections.join("\n\n")}`);
    }
  }
  return limit(capsule.join("\n\n"), config.maxChars);
}
