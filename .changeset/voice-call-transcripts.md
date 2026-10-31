---
"@otacon-fleet/openclaw-otacon-voice": minor
---

Save every finished call's whole report under `~/.openclaw/otacon-voice/calls/` and add the `otacon_call_log` tool (and `otaconvoice.log` gateway method) to read it. The report delivered to the session now opens with a TL;DR (the voice model's end-of-call summary, now asked for as a TL;DR of any call) and a pointer to the full transcript, and stays under 3,000 characters by keeping the end of a long call's log, so OpenClaw's 4,000-character cut on stored messages no longer drops how a call ended.
