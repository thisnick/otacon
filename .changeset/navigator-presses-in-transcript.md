---
"@otacon-fleet/openclaw-otacon-voice": minor
---

The phone-menu navigator sees key presses in its transcript, where they happened, instead of in a separate list. "Wait" now depends on what the line is doing (still talking, nothing fitting offered yet), not on what was pressed before. Pressing is right when a fitting option was offered and no key has been pressed since. A menu that comes after a key press is answered even when its option uses the same key, which the Met's two "press 1" menus got stuck on. On every hang-up, ours or theirs, the voice model is told the call has ended and gets a second of silence. The report waits up to 10 s for its last transcript, so a recording the navigator hung up on still reaches the log.
