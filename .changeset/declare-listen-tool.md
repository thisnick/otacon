---
"@otacon-fleet/openclaw-otacon-voice": patch
---

Declare `otacon_listen` in the manifest's `contracts.tools`. OpenClaw drops tools a plugin doesn't declare, so the agent never saw it.
