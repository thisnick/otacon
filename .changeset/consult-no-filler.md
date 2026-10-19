---
"@otacon-fleet/openclaw-otacon-voice": patch
---

Drop `consultFiller`. OpenClaw's voice bridge holds the voice model's reply until a consult answers, so the voice model read "say Checking." only then and said it right before the answer. The voice model now introduces a lookup in its own words. The interim result only says the answer is coming, and tells it to say it's still checking if the other party talks meanwhile.
