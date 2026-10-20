# @otacon-fleet/openclaw-otacon-voice

## 3.2.1

### Patch Changes

- 288ed6e: Declare `otacon_listen` in the manifest's `contracts.tools`. OpenClaw drops tools a plugin doesn't declare, so the agent never saw it.

## 3.2.0

### Minor Changes

- 502c431: Listen-in. With `listen.to` configured, the agent gets `otacon_listen`: it calls that number from a Twilio line and plays both sides of a call in progress into it, listen-only. Hanging up the listening call, or `stop`, leaves the call itself running, and listening can start again. Calls on any line can be listened to. Lines that can place an extra call offer `listen()`; today that's Twilio.

## 3.1.0

### Minor Changes

- 7b0d1cb: The phone-menu navigator sees key presses in its transcript, where they happened, instead of in a separate list. "Wait" now depends on what the line is doing (still talking, nothing fitting offered yet), not on what was pressed before. Pressing is right when a fitting option was offered and no key has been pressed since. A menu that comes after a key press is answered even when its option uses the same key, which the Met's two "press 1" menus got stuck on. On every hang-up, ours or theirs, the voice model is told the call has ended and gets a second of silence. The report waits up to 10 s for its last transcript, so a recording the navigator hung up on still reaches the log.

## 3.0.0

### Major Changes

- 0294ffc: Twilio numbers as phone lines, beside otacon phones. The config now lists `lines` (`provider: "otacon"` or `"twilio"`) and a `defaultLine`; the `otacon` block is gone. This is breaking: see "Upgrading from 2.x" in the README. Every line takes incoming calls, and `otacon_call` gets a `line` choice when there is more than one. Each line has one call at a time; different lines can run calls at once. A Twilio line places calls through the REST API and carries audio over Media Streams, with routes on the gateway under `/otacon-voice/twilio/<line>/` checked with Twilio's signature. Key presses redirect the call, holds route the voice model to the active call, and joining two lines uses a Twilio conference. Callers not on the allowlist are rejected. Reports name the line a call was on.

## 2.6.0

### Minor Changes

- a8165a6: New `inboundGreeting` setting, as in voice-call: the voice model's first words on an incoming call include it (default "Hello! How can I help you today?"; empty: it waits for the caller). The built-in greeting that named the assistant and the owner ("…answering Nick's phone") is gone.

## 2.5.1

### Patch Changes

- b4f379e: Drop `consultFiller`. OpenClaw's voice bridge holds the voice model's reply until a consult answers, so the voice model read "say Checking." only then and said it right before the answer. The voice model now introduces a lookup in its own words. The interim result only says the answer is coming, and tells it to say it's still checking if the other party talks meanwhile.

## 2.5.0

### Minor Changes

- 0308a7b: Holds belong to the phone-menu navigator now. It times them with the local speech/music detector, which runs alongside the transcriber, and hangs up past the hold limit: `holdCapSeconds`, or the new `holdLimitMinutes` on `otacon_call`. After 10 s of hold music it stops the line reaching the voice model until someone speaks. The voice model's `wait_on_hold` tool is gone; asked to hold, it says "Sure, I'll hold." The navigator hands off only when the line waits for a spoken answer, not on a greeting, and retries a key press that failed. When the other side hangs up right after speaking, the report keeps its last words.

## 2.4.0

### Minor Changes

- 6d43b97: `realtime.agentContext`, as in the stock voice-call plugin: with `enabled: true`, the voice model's instructions get the agent's configured identity and the workspace files SOUL.md, IDENTITY.md and USER.md (up to 6000 characters), so it knows who it is and who it works for. Built the same way as voice-call's; checked identical on a real workspace.

## 2.3.0

### Minor Changes

- e9dee2e: The navigator's press, hand-off and hang-up are one decision, so they now use one threshold, `menu.threshold` (0.6), in place of `menu.pressThreshold`, `handOffThreshold` and `hangUpThreshold`. On the MoMA visitor line the navigator wavered under the old 0.8 bar and never pressed. Its log line now names the key it would press.

## 2.2.0

### Minor Changes

- c7ef1d0: A phone-menu navigator for calls an agent places. A live transcript of the line (`gpt-live-transcribe`) goes to a decision model on OpenRouter (Luna Decisions) every 3 s. The navigator presses menu options the moment they're read, hangs up above 0.9 when the goal is done or can't be reached, and hands the call to the voice model once a person speaks. It stays silent and leaves information entry to the voice model. Each model sees the other's key presses: the voice model through silent notes. The OpenRouter key is a SecretRef (`menu.decisions.apiKey`).

  Also: while a consult runs, the voice model says `consultFiller` ("Checking." by default), using the SDK's interim tool result. Key presses are silent, made the moment an option is heard.

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
