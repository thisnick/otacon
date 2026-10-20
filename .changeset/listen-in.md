---
"@otacon-fleet/openclaw-otacon-voice": minor
---

Listen-in. With `listen.to` configured, the agent gets `otacon_listen`: it calls that number from a Twilio line and plays both sides of a call in progress into it, listen-only. Hanging up the listening call, or `stop`, leaves the call itself running, and listening can start again. Calls on any line can be listened to. Lines that can place an extra call offer `listen()`; today that's Twilio.
