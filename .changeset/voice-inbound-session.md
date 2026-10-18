---
"@otacon-fleet/openclaw-otacon-voice": minor
---

`inboundSessionKey`: the session incoming calls belong to (their report and consults). Without it, reports went to `agent:<agentId>:main`, which the owner never sees when each chat has its own session (`session.dmScope`).
