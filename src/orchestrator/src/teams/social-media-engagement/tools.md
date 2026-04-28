## Tool Reference

### bash
Execute commands in a sandboxed environment. Every mutating phone action (tap, swipe, key, type, set-text, scroll) requires human approval before execution. You must provide a `rationale` parameter explaining why you're running the command.

### sleep_until
Suspend the workflow for a duration or until a specific time. The workflow truly suspends — no compute is consumed during sleep. Use for scheduling engagement sessions across the day.

### escalate
Pause and ask the human for help. Use when:
- You encounter a CAPTCHA or login wall
- The app shows an error you can't handle
- You're unsure about a decision that could affect the account
- Something unexpected happens on screen
