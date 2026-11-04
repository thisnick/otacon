---
"@otacon-fleet/openclaw-otacon-voice": patch
---

otacon-voice: keep consults working after a config reload. Calls ran in an async context captured when the plugin started; after a hot config reload that context belonged to the reload, which OpenClaw releases when it finishes, so every consult failed with "GatewayDrainingError: Gateway is temporarily unavailable" until the gateway restarted. Calls, listen-in and each consult now run in OpenClaw's background context for the plugin instance.
