---
"@otacon-fleet/openclaw-otacon-voice": minor
---

A phone-menu navigator for calls an agent places. A live transcript of the line (`gpt-live-transcribe`) goes to a decision model on OpenRouter (Luna Decisions) every 3 s. The navigator presses menu options the moment they're read, hangs up above 0.9 when the goal is done or can't be reached, and hands the call to the voice model once a person speaks. It stays silent and leaves information entry to the voice model. Each model sees the other's key presses: the voice model through silent notes. The OpenRouter key is a SecretRef (`menu.decisions.apiKey`).

Also: while a consult runs, the voice model says `consultFiller` ("Checking." by default), using the SDK's interim tool result. Key presses are silent, made the moment an option is heard.
