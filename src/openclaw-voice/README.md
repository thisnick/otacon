# otacon-voice (OpenClaw plugin)

Phone calls through an [otacon](../../README.md) phone, carried out by a
realtime voice model, with the OpenClaw agent behind it.

- **Agent tool `otacon_call`**: place a call with a goal (`brief`); it runs in
  the background, and when it ends the whole call log (both sides,
  timestamped, plus events such as keys pressed, hold, lines joined) is
  delivered to the requesting session as a system message, for the agent to
  summarize and act on.
- **On the call** the voice model can press keys (`send_dtmf`, sent over
  Bluetooth HFP as `AT+VTS`), wait on hold (`wait_on_hold`), consult the
  agent (`openclaw_agent_consult`), end the call with a summary, and, when
  contacts are allowed, bring a person in on a second line and join the
  lines (`call_party`, `switch_line`, `connect_lines`, `drop_line`).
- **Hold**: while holding, the model hears nothing (hold music never reaches
  it). A local speech detector (Silero VAD, run with onnxruntime) wakes it
  with ~2 s of pre-roll when someone speaks. 30 s without speech enters hold
  on its own. `holdCapSeconds` (default 300) hangs up and reports.
- **Inbound**: with `inboundPolicy: "allowlist"`, calls from `allowFrom` are
  answered; all others are left ringing.

It talks to otacon's `ws/voice/control` socket for one phone (see
`docs/voice-ws.md`), which the plugin holds for as long as it runs.

## Config (`plugins.entries.otacon-voice.config`)

```json
{
  "otacon": { "url": "https://otacon-pi.<tailnet>.ts.net:8080", "phoneId": "phone-r5ct60sd" },
  "ownerName": "Nick",
  "assistantName": "Nick's assistant",
  "inboundPolicy": "allowlist",
  "allowFrom": ["+15550001111"],
  "toolPolicy": "safe-read-only",
  "realtime": { "provider": "openai", "providers": { "openai": { "model": "gpt-realtime-2.1", "voice": "marin" } } },
  "contacts": { "nick": { "name": "Nick", "number": "+15550002222", "description": "the owner" } },
  "holdCapSeconds": 300
}
```

The realtime API key comes from `realtime.providers.openai.apiKey` (a
SecretRef), an OpenAI auth profile, or `OPENAI_API_KEY`.

Each call runs in an OpenClaw session, where its consults happen, chosen as
the stock voice-call plugin chooses it. With `sessionScope: "per-phone"`
(the default), that's `agent:<agentId>:voice:<digits>`: every call with the
same number shares one session, so the agent remembers earlier calls (the
same keys as voice-call, so its sessions carry over). `"per-call"` gives
each call its own session and `"main"` uses the agent's main session.
`otacon_call` can name the session instead (`sessionKey`).

Incoming calls belong to `agent:<agentId>:main` unless `inboundSessionKey`
names another session: the report goes there, and consults during the call
see that conversation. With `session.dmScope` giving each chat its own
session, set it to the owner's chat (for example
`agent:main:whatsapp:direct:+15550002222`) so call reports reach them.

When the voice model consults the agent, the agent answers with
`responseModel` (default: the agent's model). `consultThinkingLevel` (for
example `"low"`) and `consultFastMode: true` keep those answers quick while
the other party waits.

## Third-party

`assets/silero_vad.onnx` is [Silero VAD](https://github.com/snakers4/silero-vad)
v5.1.2, MIT licensed (`assets/silero_vad.LICENSE`).

## Install

```sh
openclaw plugins install @otacon-fleet/openclaw-otacon-voice --accept-capabilities
```

then add `otacon-voice` to `plugins.allow`, set its config, and restart the
gateway (secrets resolve at start).

## Build and release

```sh
pnpm install && pnpm --filter @otacon-fleet/openclaw-otacon-voice test && (cd src/openclaw-voice && npm pack)   # local tarball
```

Releases go to npm as `@otacon-fleet/openclaw-otacon-voice` through
changesets (`pnpm changeset`, then the Version Packages PR); see
`docs/releasing.md`. End-to-end tests:
`tests/voice/README.md`.
