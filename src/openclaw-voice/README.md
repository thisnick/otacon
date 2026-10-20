# otacon-voice (OpenClaw plugin)

Phone calls through [otacon](../../README.md) phones and Twilio numbers,
carried out by a realtime voice model, with the OpenClaw agent behind it.
Each configured line (a phone or a number) takes incoming calls and can
place calls; the agent picks the line, or the default one is used.

- **Agent tool `otacon_call`**: place a call with a goal (`brief`); it runs in
  the background, and when it ends the whole call log (both sides,
  timestamped, plus events such as keys pressed and lines joined) is
  delivered to the requesting session as a system message, for the agent to
  summarize and act on. When the other side hangs up, the report waits up to
  3 s for its last words.
- `otacon_call` takes `holdLimitMinutes` to set how long that call waits on
  hold (default `holdCapSeconds`, 300 s; at most `maxCallSeconds`, 1800 s),
  and, with more than one line, `line` (default `defaultLine`). Each line
  has at most one call at a time; different lines can have calls at once.
- **On the call** the voice model can press keys (`send_dtmf`: over
  Bluetooth HFP as `AT+VTS` on a phone, a `<Play digits>` redirect on
  Twilio), consult the agent (`openclaw_agent_consult`), end the call with a summary, and, when
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
  answered; all others are left ringing (a Twilio line rejects them). The
  voice model speaks first, its
  first words including `inboundGreeting` (default "Hello! How can I help
  you today?", as voice-call; `""`: it waits for the caller).

A phone line talks to otacon's `ws/voice/control` socket for its phone (see
`docs/voice-ws.md`), which the plugin holds for as long as it runs. A Twilio
line is described under [Twilio lines](#twilio-lines).

## Config (`plugins.entries.otacon-voice.config`)

```json
{
  "lines": [
    { "id": "sim", "provider": "otacon", "url": "https://otacon-pi.<tailnet>.ts.net:8080", "phoneId": "phone-r5ct60sd", "number": "+15550003333" },
    {
      "id": "twilio", "provider": "twilio",
      "accountSid": "AC…",
      "authToken": { "source": "store", "provider": "default", "id": "TWILIO_AUTH_TOKEN" },
      "fromNumber": "+15550004444",
      "publicUrl": "https://<host>.<tailnet>.ts.net/otacon-voice/twilio/twilio"
    }
  ],
  "defaultLine": "sim",
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

`id` is what the agent picks; the tool's description lists each line with
its `number` (a Twilio line's is `fromNumber`). `defaultLine` defaults to
the first line.

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
the other party waits. The voice model introduces the lookup in its own
words; while the agent works, its result for the consult says the answer
is coming, so if the other party talks meanwhile the model tells them it's
still checking.

## Twilio lines

A Twilio line places calls through Twilio's REST API and carries their audio
over bidirectional Media Streams (8 kHz µ-law, converted to the plugin's
16 kHz). The gateway serves its routes, under
`/otacon-voice/twilio/<line id>/`:

- `answer`: the number's voice URL (POST). Allowlisted callers get the
  stream; everyone else, or anyone while the line is busy, gets `<Reject/>`.
- `status`: call status callbacks (POST). Calls the line places set it
  themselves; set it on the number too, so incoming calls report their end.
- `stream`: the media stream (WebSocket).

Twilio has to reach them: expose the path publicly (for example
`tailscale funnel --bg --set-path /otacon-voice/twilio https+insecure://127.0.0.1:18789/otacon-voice/twilio`)
and set `publicUrl` to the public URL of the line's routes. Webhooks are
checked with `X-Twilio-Signature` against `publicUrl`, so it must be exactly
what Twilio calls; streams carry a token of their own. On the Twilio number,
set the voice URL to `<publicUrl>/answer` and the status callback to
`<publicUrl>/status`, both POST.

How a phone's features map onto Twilio:

- Key presses: Twilio can't send them over a media stream, so a press
  redirects the call to `<Play digits>` and then a new stream. The voice
  model's session carries on; the audio pauses briefly while the stream is replaced.
- Hold, swap, a second line: each call has its own stream, and the line
  routes the voice model to the active one. A held call hears silence.
- Joining two lines (`connect_lines`): both calls are redirected into a
  Twilio conference that ends when either leaves; the assistant drops off.

## Listen-in

With `listen: { "to": "+1…" }` the agent gets `otacon_listen`. `start`
calls that number (only that one) from a Twilio line and plays both sides of
a call in progress into it: the other party and the voice model, mixed at
the line's pace, with a short spoken intro. It's listen-only: what the
listener says is dropped, and the voice model and the navigator don't know
about it. `stop`, or the listener hanging up, ends only the listening call;
the call carries on, and listening can start again. When the call ends, the
listening call is hung up. Calls on any line can be listened to; the
listening call needs a line that can place an extra call (`listen.line`,
default the first Twilio line), so it's off without one.

## Upgrading from 2.x

3.0 replaces the `otacon` block with `lines`. OpenClaw checks the config
against both the installed and the new plugin's schema, so install over a
2.x plugin fails whichever shape the config has. With the gateway stopped:

1. `openclaw plugins uninstall otacon-voice --force` (its 2.x config is still valid);
2. `openclaw plugins install @otacon-fleet/openclaw-otacon-voice@3 --force --accept-capabilities`
   (it stays off until configured);
3. write the config with `lines` (the old `otacon` block becomes
   `{ "id": …, "provider": "otacon", "url": …, "phoneId": … }`), then
   `openclaw plugins enable otacon-voice`.

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
