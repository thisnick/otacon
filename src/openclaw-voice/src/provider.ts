// The realtime-voice provider at its public boundary: createBridge and the
// request the SDK hands it.

import type { RealtimeVoiceAudioFormat, ResolvedProvider } from "openclaw/plugin-sdk/realtime-voice";

type Provider = ResolvedProvider["provider"];
type BridgeRequest = Record<string, unknown> & { audioFormat?: RealtimeVoiceAudioFormat };

/**
 * `provider`, with each createBridge request's audio format copied into a
 * plain object (encoding, sample rate, channels).
 *
 * Since OpenClaw 2026.11.1, createRealtimeVoiceBridgeSession hands the
 * provider a lifecycle-owned view of its request when it runs inside a
 * managed plugin instance, as calls do (runtime.ts runs them in the plugin's
 * background context). The view is a Proxy, nested objects included.
 * GPT-Live's gateway-relay transport puts audioFormat in a media Worker's
 * workerData, and structured cloning refuses a Proxy ("DataCloneError:
 * #<Object> could not be cloned"), so the call failed before the model
 * connected. Realtime models only read the format's fields, which a view
 * allows.
 *
 * The rest of the request (config, callbacks, tools, consult) is passed on
 * as the SDK made it, so the SDK keeps ownership of it.
 */
export function withCloneableAudioFormat(provider: Provider): Provider {
  const createBridge = provider.createBridge;
  if (typeof createBridge !== "function") return provider;
  return {
    ...provider,
    createBridge(request: BridgeRequest) {
      const f = request.audioFormat;
      if (!f) return createBridge.call(provider, request);
      return createBridge.call(provider, { ...request, audioFormat: { encoding: f.encoding, sampleRateHz: f.sampleRateHz, channels: f.channels } });
    },
  };
}
