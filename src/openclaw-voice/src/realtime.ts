// The realtime-voice SDK as call missions use it (see RealtimeSdk in call.ts).

import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  consultRealtimeVoiceAgent,
  createRealtimeVoiceBridgeSession,
  createStreamingPcmResampler,
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveAgentIdentity, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import { root } from "openclaw/plugin-sdk/security-runtime";
import { canonicalizeMainSessionAlias } from "openclaw/plugin-sdk/session-store-runtime";
import type { RealtimeSdk } from "./call.js";

export const realtimeSdk: RealtimeSdk = {
  consultTool: REALTIME_VOICE_AGENT_CONSULT_TOOL,
  consultToolName: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resolveProvider: resolveConfiguredRealtimeVoiceProvider,
  createSession: createRealtimeVoiceBridgeSession,
  consult: consultRealtimeVoiceAgent,
  consultToolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow,
  resampler: createStreamingPcmResampler,
  sessionKeys: { normalizeAgentId, parseAgentSessionKey, canonicalizeMainSessionAlias },
  resolveSecretRefs: resolveSecretRefValues,
  agentContext: { resolveAgentIdentity, resolveAgentWorkspaceDir, workspaceRoot: (dir) => root(dir) },
};
