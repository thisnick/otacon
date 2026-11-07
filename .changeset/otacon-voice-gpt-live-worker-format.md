---
"@otacon-fleet/openclaw-otacon-voice": patch
---

otacon-voice: GPT-Live calls connect again on OpenClaw 2026.11.1. The SDK now hands the voice provider a lifecycle-owned view of the session request, and GPT-Live's gateway-relay transport sends the request's audio format to a media Worker, which can't clone the view (`DataCloneError: #<Object> could not be cloned`), so the call failed before the model connected. The provider now gets the audio format as a plain object (encoding, sample rate, channels); the rest of the request (config, callbacks, tools, consult) stays as the SDK made it. Realtime models were not affected.
