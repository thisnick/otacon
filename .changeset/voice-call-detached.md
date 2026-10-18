---
"@otacon-fleet/openclaw-otacon-voice": patch
---

Fix: consults failed on calls an agent placed ("Async work scope is closed", or GatewayDrainingError). The call ran in the async context of the agent turn that called `otacon_call`, which OpenClaw closes when the turn ends; calls now run in the plugin service's own context, like incoming calls.
