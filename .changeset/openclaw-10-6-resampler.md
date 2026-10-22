---
"@otacon-fleet/openclaw-otacon-voice": patch
---

Load on OpenClaw 2026.10.6: import the streaming PCM resampler from `openclaw/plugin-sdk/realtime-voice-provider`, since `realtime-voice` no longer re-exports it.
