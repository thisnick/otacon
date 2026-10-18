---
"@otacon-fleet/openclaw-otacon-voice": minor
---

Calls run in a session chosen like the stock voice-call plugin's: `sessionScope` `per-phone` (the default: one session per phone number, `agent:<agentId>:voice:<digits>`, so the agent remembers earlier calls with that number, including ones made with voice-call), `per-call` or `main`, and `otacon_call` takes a `sessionKey` to name the session itself. Each call used to get a new session. The report names the call's session.
