---
"@otacon-fleet/openclaw-otacon-voice": minor
---

Holds belong to the phone-menu navigator now. It times them with the local speech/music detector, which runs alongside the transcriber, and hangs up past the hold limit: `holdCapSeconds`, or the new `holdLimitMinutes` on `otacon_call`. After 10 s of hold music it stops the line reaching the voice model until someone speaks. The voice model's `wait_on_hold` tool is gone; asked to hold, it says "Sure, I'll hold." The navigator hands off only when the line waits for a spoken answer, not on a greeting, and retries a key press that failed. When the other side hangs up right after speaking, the report keeps its last words.
