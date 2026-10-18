# @otacon-fleet/openclaw-otacon-voice

## 2.1.1

### Patch Changes

- 994f9e2: Fix: consults failed on calls an agent placed ("Async work scope is closed", or GatewayDrainingError). The call ran in the async context of the agent turn that called `otacon_call`, which OpenClaw closes when the turn ends; calls now run in the plugin service's own context, like incoming calls.

## 2.1.0

### Minor Changes

- 661fe58: `inboundSessionKey`: the session incoming calls belong to (their report and consults). Without it, reports went to `agent:<agentId>:main`, which the owner never sees when each chat has its own session (`session.dmScope`).
- dcee7dd: Calls run in a session chosen like the stock voice-call plugin's: `sessionScope` `per-phone` (the default: one session per phone number, `agent:<agentId>:voice:<digits>`, so the agent remembers earlier calls with that number, including ones made with voice-call), `per-call` or `main`, and `otacon_call` takes a `sessionKey` to name the session itself. Each call used to get a new session. The report names the call's session.

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
