// Types for the parts of the OpenClaw plugin SDK this plugin uses. The SDK
// ships no type declarations for these entry points (2026.10.3), so these are
// written from the compiled SDK; keep them minimal.

declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface PluginLogger {
    debug?(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  }
  export interface ToolContext {
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    senderIsOwner?: boolean;
    messageChannel?: string;
  }
  export interface AgentToolResult {
    content: { type: "text"; text: string }[];
    details?: unknown;
  }
  export interface AgentTool {
    name: string;
    label?: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(toolCallId: string, params: any): Promise<AgentToolResult>;
  }
  export interface GatewayMethodOptions {
    params: any;
    respond(ok: boolean, payload?: unknown, error?: unknown): void;
  }
  export interface ServiceContext {
    config: unknown;
    stateDir: string;
    logger: PluginLogger;
    serviceHealth?: { reportFailure(err: unknown): void; clearFailure(): void };
  }
  export interface AgentRuntime {
    defaults: { provider: string; model: string };
    resolveThinkingDefault?(p: { cfg: unknown; provider: string; model: string }): string | undefined;
    [key: string]: unknown;
  }
  export interface PluginRuntime {
    agent: AgentRuntime;
    system: {
      enqueueSystemEvent(text: string, opts: { sessionKey: string; contextKey?: string }): boolean;
      requestHeartbeatNow(opts?: { sessionKey?: string; agentId?: string; reason?: string; source?: string }): void;
    };
    [key: string]: unknown;
  }
  export interface PluginApi {
    id: string;
    rootDir: string;
    registrationMode: string;
    config: any;
    pluginConfig: unknown;
    runtime: PluginRuntime;
    logger: PluginLogger;
    registerTool(factory: AgentTool | ((ctx: ToolContext) => AgentTool | AgentTool[] | null)): void;
    registerGatewayMethod(
      method: string,
      handler: (opts: GatewayMethodOptions) => void | Promise<void>,
      opts?: { scope?: string },
    ): void;
    registerService(service: {
      id: string;
      start(ctx: ServiceContext): void | Promise<void>;
      stop?(ctx: ServiceContext): void | Promise<void>;
    }): void;
  }
  export function definePluginEntry(opts: {
    id: string;
    name: string;
    description: string;
    configSchema?: { parse(value: unknown): unknown };
    register(api: PluginApi): void;
  }): unknown;
}

declare module "openclaw/plugin-sdk/routing" {
  export function normalizeAgentId(id: string): string;
  export function parseAgentSessionKey(key: string): { agentId: string; rest: string } | null;
}

declare module "openclaw/plugin-sdk/session-store-runtime" {
  export function canonicalizeMainSessionAlias(p: { cfg: unknown; agentId: string; sessionKey: string }): string;
}

declare module "openclaw/plugin-sdk/tool-results" {
  import type { AgentToolResult } from "openclaw/plugin-sdk/plugin-entry";
  export function jsonResult(payload: unknown): AgentToolResult;
}

declare module "openclaw/plugin-sdk/realtime-voice" {
  export type RealtimeVoiceAudioFormat =
    | { encoding: "g711_ulaw"; sampleRateHz: 8000; channels: 1 }
    | { encoding: "pcm16"; sampleRateHz: 24000; channels: 1 };
  export const REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: RealtimeVoiceAudioFormat;
  export const REALTIME_VOICE_AGENT_CONSULT_TOOL: RealtimeToolSpec;
  export const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME: string;

  export interface RealtimeToolSpec {
    type: "function";
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  }
  export interface ResolvedProvider {
    provider: { id: string; [key: string]: unknown };
    providerConfig: Record<string, unknown>;
    capabilities?: unknown;
  }
  export function resolveConfiguredRealtimeVoiceProvider(p: {
    configuredProviderId?: string;
    providerConfigs?: Record<string, unknown>;
    cfg: unknown;
    agentId?: string;
    surface?: string;
    useProviderDefaultModel?: boolean;
  }): ResolvedProvider;

  export interface ToolCallEvent {
    itemId?: string;
    callId?: string;
    name: string;
    args: any;
  }
  export interface BridgeSession {
    connect(): Promise<void>;
    sendAudio(audio: Buffer): void;
    sendUserMessage(text: string): void;
    submitToolResult(
      callId: string,
      result: unknown,
      options?: { willContinue?: boolean; suppressResponse?: boolean },
    ): void | Promise<void>;
    handleBargeIn(options?: { audioPlaybackActive?: boolean; force?: boolean }): void;
    acknowledgeMark(name?: string): void;
    close(options?: { disposition?: "detach" }): void | Promise<void>;
  }
  export function createRealtimeVoiceBridgeSession(p: {
    provider: ResolvedProvider["provider"];
    providerConfig: Record<string, unknown>;
    capabilities?: unknown;
    cfg?: unknown;
    agentId?: string;
    audioFormat?: RealtimeVoiceAudioFormat;
    instructions?: string;
    tools?: RealtimeToolSpec[];
    markStrategy?: "transport" | "ack-immediately" | "ignore";
    interruptResponseOnInputAudio?: boolean;
    audioSink: {
      isOpen?(): boolean;
      sendAudio(audio: Buffer, metadata?: { itemId?: string }): void;
      clearAudio?(reason?: string): void;
      sendMark?(name: string, ack?: () => void): void;
      getPlaybackState?(): { itemId: string; audioEndMs: number }[];
    };
    onTranscript?(role: "user" | "assistant", text: string, isFinal: boolean): void;
    onToolCall?(ev: ToolCallEvent, session: BridgeSession): void | Promise<void>;
    onResponseDone?(outcome: { status: string; responseId?: string; message?: string }): void;
    onReady?(session: BridgeSession): void;
    onError?(err: Error): void;
    onClose?(reason: string): void;
  }): BridgeSession;

  export function consultRealtimeVoiceAgent(p: Record<string, unknown>): Promise<{ text: string; yielded?: true }>;
  export function resolveRealtimeVoiceAgentConsultToolsAllow(policy: string): string[] | undefined;
  export function buildRealtimeVoiceAgentConsultWorkingResponse(audience: string): unknown;

  export function createStreamingPcmResampler(
    inRate: number,
    outRate: number,
  ): { process(chunk: Buffer): Buffer; flush(): Buffer };
}
