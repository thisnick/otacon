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
};
