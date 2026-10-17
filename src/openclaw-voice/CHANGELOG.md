# @otacon-fleet/openclaw-otacon-voice

## 2.0.0

### Major Changes

- Everything in the repo now shares one version and is released together: the npm packages, the host server, the registry and the orchestrator (docs/releasing.md).
- No plugin changes since 0.2.0.


## 0.2.0

### Minor Changes

- fff1490: Add `consultThinkingLevel` and `consultFastMode`, so consults during a call can answer quickly (same options as the stock voice-call plugin).

## 0.1.0

First release: phone calls through an otacon phone, run by a realtime voice
model, for OpenClaw agents (`otacon_call`): phone menus with DTMF, hold mode
with a local speech detector and a hold cap, agent consults, warm hand-off over
a second line, allowlisted inbound calls, and the whole call log reported back
to the agent.
