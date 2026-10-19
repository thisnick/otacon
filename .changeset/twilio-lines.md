---
"@otacon-fleet/openclaw-otacon-voice": major
---

Twilio numbers as phone lines, beside otacon phones. The config now lists `lines` (`provider: "otacon"` or `"twilio"`) and a `defaultLine`; the `otacon` block is gone. This is breaking: see "Upgrading from 2.x" in the README. Every line takes incoming calls, and `otacon_call` gets a `line` choice when there is more than one. Each line has one call at a time; different lines can run calls at once. A Twilio line places calls through the REST API and carries audio over Media Streams, with routes on the gateway under `/otacon-voice/twilio/<line>/` checked with Twilio's signature. Key presses redirect the call, holds route the voice model to the active call, and joining two lines uses a Twilio conference. Callers not on the allowlist are rejected. Reports name the line a call was on.
