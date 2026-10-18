---
"@otacon-fleet/openclaw-otacon-voice": minor
---

The navigator's press, hand-off and hang-up are one decision, so they now use one threshold, `menu.threshold` (0.6), in place of `menu.pressThreshold`, `handOffThreshold` and `hangUpThreshold`. On the MoMA visitor line the navigator wavered under the old 0.8 bar and never pressed. Its log line now names the key it would press.
