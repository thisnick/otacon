# Memory (agent-managed)

This file is the agent's persistent memory across sessions. The lead
agent appends a session-summary block at end-of-run; humans may edit it
freely between runs.

Sections the agent will append over time:

- Recent activity (what was done in prior sessions)
- People / accounts the persona has interacted with
- Pending threads (DMs to check, replies to follow up on)
- Long-term observations (what works, what doesn't)

Initial state is empty — the persona has no history yet.
