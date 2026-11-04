---
"@otacon-fleet/openclaw-otacon-voice": minor
---

otacon-voice: support GPT-Live voice models. GPT-Live can't call tools, so with `realtime.providers.openai.model: "gpt-live-1"` the voice model asks the agent for actions, and the agent acts on that call with the new `otacon_line` tool (keypad, end call, contacts, switching, joining and dropping lines). Ending and joining wait until the voice model has spoken the agent's reply, and silence is skipped while playback is behind. Realtime models behave as before.
