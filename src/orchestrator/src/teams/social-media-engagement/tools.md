## Tool Reference

You have access to three top-level tools:

### bash
Run commands in a sandboxed shell. Available commands include:
- `otacon` — drive the phone (tap, swipe, screenshot, snapshot, etc.)
- `otacon-alloc` — provision/release the phone lease
- standard shell utilities (`cat`, `echo`, `ls`, `grep`, `cd`)

The full list of `otacon` and `otacon-alloc` subcommands is in the auto-generated reference below. Mutating phone actions (tap, swipe, key, type, set-text, scroll, open, sms, call, etc.) require human approval before execution. Provide a `rationale` explaining why you're running each command.

### sleep_until
Suspend the workflow for a duration or until a specific time. The workflow truly suspends — no compute is consumed during sleep. Use for scheduling engagement sessions across the day.

### escalate
Pause and ask the human for help. Use when:
- You encounter a CAPTCHA or login wall
- The app shows an error you can't handle
- You're unsure about a decision that could affect the account
- Something unexpected happens on screen
