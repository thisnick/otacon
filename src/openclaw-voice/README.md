# otacon-voice (OpenClaw plugin)

Phone calls through an [otacon](../../README.md) phone, carried out by a
realtime voice model, with the OpenClaw agent behind it.

- **Agent tool `otacon_call`**: place a call with a goal (`brief`); it runs in
  the background, and when it ends the whole call log (both sides,
  timestamped, plus events such as keys pressed and lines joined) is
  delivered to the requesting session as a system message, for the agent to
  summarize and act on. When the other side hangs up, the report waits up to
  3 s for its last words.
- `otacon_call` takes `holdLimitMinutes` to set how long that call waits on
  hold (default `holdCapSeconds`, 300 s; at most `maxCallSeconds`, 1800 s).
- **On the call** the voice model can press keys (`send_dtmf`, sent over
  Bluetooth HFP as `AT+VTS`), consult the agent (`openclaw_agent_consult`), end the call with a summary, and, when
  contacts are allowed, bring a person in on a second line and join the
  lines (`call_party`, `switch_line`, `connect_lines`, `drop_line`).
- **Hold**: asked to hold, the voice model says "Sure, I'll hold." Holds are
  handled on calls an agent places, while the phone-menu navigator listens
  (see Phone menus): it times the hold and hangs up past the limit, and
  after 10 s of hold music the voice model stops hearing the line until
  someone speaks (it would otherwise talk through the music). Holds after a
  person has answered, and on incoming calls, aren't handled: `maxCallSeconds`
  ends the call.
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

## Agent context

`realtime.agentContext: { enabled: true }` adds the agent's voice context to
the voice model's instructions, built exactly as the stock voice-call
plugin builds it:
- the agent's configured identity (name, emoji, vibe, theme, persona);
- the workspace files `SOUL.md`, `IDENTITY.md` and `USER.md` (`files`), up to
  `maxChars` (6000).

The voice model then knows who it is and who it works for. It's off unless
enabled.

## Phone menus

On calls an agent places, a phone-menu navigator listens alongside the voice
model. A live transcript of the line (OpenAI `gpt-live-transcribe`, which
keeps pace even with a menu that never pauses) goes, with the call's goal,
to a decision model on OpenRouter (Luna Decisions by default) every
`menu.checkEverySeconds` (3):

- **Press:** an offered menu option that fits the goal, the moment it's read.
  The voice model gets a silent note.
- **Hang up:** when no person is on the line and the goal is done or can't be
  reached (a loop, closed, not in service), or the call has been on hold
  longer than its hold limit.
- **Hand off:** the line waits for a spoken answer: someone asks how they can
  help, or just says hello. A greeting or welcome alone isn't one. The
  navigator stops for the rest of the call.

A local speech detector (Silero VAD, run with onnxruntime) tells the
navigator, second by second, whether the line plays speech, music or
silence, and how long the call has been on hold (since the line went to
music or silence after the last key press; recorded messages in between
count). While music or silence plays, the navigator looks when it begins and
every 15 s. Ten seconds without speech mutes the line to the voice model;
the first second of speech unmutes it, with the last 2 s replayed.

These are one decision. The chosen action needs probability
`menu.threshold` (0.6), and a press also needs the key's.

Both models keep the keypad. Information the menu wants typed in (a phone
number, a date of birth) is the voice model's; each sees the other's
presses. Incoming calls don't use the navigator.

The OpenRouter key is required. Store it in OpenClaw's secret store, then
refer to it from the config:

```sh
printf %s "$OPENROUTER_API_KEY" | openclaw secrets store set OTACON_VOICE_OPENROUTER_API_KEY --kind secret --value-file -
```

```json
"menu": { "decisions": { "apiKey": { "source": "store", "provider": "default", "id": "OTACON_VOICE_OPENROUTER_API_KEY" } } }
```

The transcript uses the realtime provider's OpenAI key unless
`menu.transcription.apiKey` names another. `menu.enabled: false` turns the
navigator off.

When the voice model consults the agent, the agent answers with
`responseModel` (default: the agent's model). `consultThinkingLevel` (for
example `"low"`) and `consultFastMode: true` keep those answers quick while
the other party waits. Meanwhile the voice model says `consultFiller`
("Checking." by default).

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
