# Voice protocol (v1)

Everything about a phone's calls lives under `/phones/{id}/ws/voice/`, split
by kind of client:

| Endpoint | Clients | Carries |
|---|---|---|
| `wss://<host>:8080/phones/{id}/ws/voice/control[?takeover=1]` | **Interactive**, one owner | Commands, call events, full-duplex call audio |
| `wss://<host>:8080/phones/{id}/ws/voice/monitor` | **Read-only**, any number | Call events + both sides of the call as stereo (left: the other party, right: our side) |

No webhooks or callback URLs. `{id}` is the host phone id (e.g.
`phone-r5ct60sd`). Access is the same as every other per-phone endpoint:
Tailscale is the authentication (tailnet only, no token).

Most of this document describes `ws/voice/control`. The read-only endpoints are
covered in [Read-only clients](#read-only-clients).

## Principles

- **The phone is the source of truth.** Call control goes over Bluetooth HFP
  (AT commands on the BlueALSA RFCOMM channel). State comes from HFP
  indicators (`+CIEV`) plus `AT+CLCC`. ADB is only used where HFP can't
  answer (caller ID on some phones, disconnect causes).
- **Calls outlive the socket.** Closing or losing the WebSocket never hangs up
  a call. A client that reconnects gets the current state in `hello`.
- **One controller per phone.** A second connection is refused with HTTP 409
  (`{"error": "voice_control_in_use", ...}`).
  With `?takeover=1` the server closes the existing socket (close code 4001)
  and accepts the new one.
- **Commands are serialized per phone** and acknowledged individually, whether
  they arrive on this socket or through REST (see below).
- **Replaces `/ws/audio/call`**, which is removed.

## Frames

- **Text frames** carry JSON objects with a `type` field.
- **Binary frames** carry audio: `pcm_s16le`, mono, at `audio.sampleRate`
  from `hello` (16000 on the Bluetooth backend).
  - Server → client: what the phone hears (the other party), 20 ms per frame.
  - Client → server: what the other party should hear. Any length; the
    server queues it and plays it at real time.

Text and binary frames go out on one socket in timeline order, so an event
arrives at its point in the audio. Every server message also carries:

- `ts`: server time, epoch milliseconds;
- `audioPos`: how many audio samples (per channel) the server has sent on this
  socket before this message. For example, `call.state` → `active` with
  `audioPos: 48000` means the call was answered 3 s into the received audio.

## Calls

The phone routes exactly one call's audio at a time (the active call). Held
calls are silent in both directions.

```json
{
  "id": "call_7f3a9c",
  "number": "+15551234567",
  "direction": "outgoing",
  "state": "active",
  "conference": false,
  "startedAt": 1792204710222,
  "answeredAt": 1792204728674
}
```

| Field | Meaning |
|---|---|
| `id` | Assigned by otacon when it first sees the call: a short random string, never reused (not a counter, which would restart with the server). Stable for the life of the call, including across a merge. HFP's own call index changes after a merge, so it is never exposed. If the server restarts mid-call, the call is rediscovered with a new `id` and listed in `hello`. |
| `number` | E.164 if known, else `null` |
| `numberSource` | Where `number` came from: `hfp` (the phone's Bluetooth link) or `kiosk` (the kiosk's call watcher). Absent while `number` is `null`. |
| `direction` | `outgoing` or `incoming` |
| `state` | `dialing` → `alerting` (remote is ringing) → `active`; or `incoming` → `active`; `active` ⇄ `held`; finally `ended` |
| `conference` | `true` while the call is part of a merged call |
| `answeredAt` | When the call first became `active`. For outgoing calls this is the real remote answer, not when we started dialing. |

## Server → client events

```json
{"type":"hello","protocol":1,"phoneId":"phone-r5ct60sd","number":"+15550100000",
 "audio":{"format":"pcm_s16le","sampleRate":16000,"channels":1,"frameMs":20},
 "audioLink":false,
 "hfp":{"connected":true,"chld":["0","1","1x","2","2x","3"]},
 "calls":[],"ts":1792204700000,"audioPos":0}
```

| `type` | Payload | When |
|---|---|---|
| `hello` | protocol version, phone number, audio format, whether the audio link is up (`audioLink`), HFP status and the phone's supported `AT+CHLD` options, current `calls` | Once, on connect |
| `call.incoming` | `call` | A call starts ringing on the phone (see Caller ID below) |
| `call.state` | `call` | Any change to one call (state, number, conference flag) |
| `call.ended` | `call`, `reason`, optional `cause` | A call is gone. `reason`: `local` (otacon ended it: `hangup`), `rejected` (otacon declined it: `reject`), `remote` (the other side or the network ended an answered call, or an incoming caller gave up), `failed` (an outgoing call ended before it was answered: busy, declined, unreachable, no answer) or `unknown`. `cause` is Android's disconnect cause when ADB can read it (e.g. `BUSY`), best effort, not yet implemented. |
| `audio.link` | `up` (bool) | The Bluetooth audio link opened or closed. Audio frames only flow while it is up. |
| `mark` | `name`, `cleared` (bool) | Uplink playback reached a mark, or the mark was discarded by `clear` (`cleared: true`) |
| `hfp` | `connected` (bool) | The phone's Bluetooth control link went up or down |
| `ack` | `id`, optional `result` | A command was carried out and its resulting state is visible (see Command ids and replies) |
| `error` | `id` (`null` when the message has no usable id), `code`, `message` | A command failed, or a protocol error |

## Client → server commands

### Command ids and replies

Every command except `mark` carries an `id` chosen by the client (e.g. a
counter) and gets **exactly one** reply: an `ack` or an `error` with that `id`.
`mark` takes no `id`; its reply is the `mark` event, matched by `name`.

- **Valid ids** are strings of 1–64 characters. A missing or invalid `id`
  means the command is not executed, and the reply is `error` with
  `id: null` and `code: bad_request`.
- **The server only remembers ids of commands still in flight** on this
  connection, and forgets each one when it replies. A command reusing an
  in-flight `id` is not executed: `error` with that `id` and
  `code: duplicate_id`. Reusing an id after its reply is fine.
- **Order:** call-control commands on one socket run one at a time, in the
  order received, and their replies come back in that order. `mark` and
  `clear` act on the audio queue at once, in order with the audio frames
  around them, so a `clear` is never stuck behind a slow `dial`; its ack can
  arrive before the ack of a call command sent earlier.
- **An `ack` means done and visible.** It is sent only after the phone has
  carried out the command *and* the resulting state is visible. Every
  `call.state` event caused by the command is sent before its `ack`, so a
  client that has the ack already has the current state. If the phone
  answers `OK` but the expected state never appears, the reply is `error`
  with `code: timeout`.
- **If the socket closes** before a reply, the command still completes on the
  phone; the reply is lost. After reconnecting, `hello` shows the real state.

A typical client keeps a map of pending ids, resolves an entry on `ack`,
rejects it on `error`, and treats every other message (call events, `mark`,
errors with `id: null`) as an event.

| `type` | Fields | Effect | HFP |
|---|---|---|---|
| `dial` | `to` (E.164) | Place a call. If a call is active, the phone puts it on hold first. `ack.result.call` is the new call. | `ATD<to>;` |
| `answer` | `call?` | Answer the ringing call. `ack.result.call` is the answered call. A call waiting behind an active call is answered by putting the active call on hold. | `ATA`; call waiting: `AT+CHLD=2` |
| `reject` | `call?` | Decline the ringing call (the caller usually lands in voicemail). `ack.result` is `{}` (also for `hangup`). | `AT+CHUP`; call waiting: `AT+CHLD=0` |
| `hangup` | `call?` | End one call; defaults to the active call. Ending a call that is part of a merged call ends the whole merged call. | active or ringing out: `AT+CHUP`; held: `AT+CHLD=0` |
| `hold` | — | Put the active call on hold. `ack.result.calls` (also for `resume`, `swap`, `merge`) is every call afterwards. | `AT+CHLD=2` |
| `resume` | — | Make the held call active (only when nothing is active) | `AT+CHLD=2` |
| `swap` | — | With one active and one held call: swap them | `AT+CHLD=2` |
| `merge` | — | Join the active and held calls into one merged call | `AT+CHLD=3` |
| `dtmf` | `digits` | Send keypad digits on the active call: `0-9 * # A-D`; `w` waits 500 ms. Acked after the last digit, with `ack.result.digits`. | `AT+VTS=<d>` per digit (case-insensitive, up to 100 characters) |
| `mark` | `name` | Insert a mark into the uplink audio queue. A `mark` event fires when playback reaches it. | — |
| `clear` | — | Drop all queued uplink audio, so the other party can interrupt (see Interruptions). `ack.result.droppedMs` is how much queued audio was discarded. Pending marks are reported with `cleared: true`. | — |
| `status` | — | `ack.result.calls`: a fresh snapshot, re-read from the phone | `AT+CLCC` |

The server checks each command against the current state first. For example,
`merge` without one active and one held call fails with `invalid_state`
instead of reaching the phone.

### Error codes

| `code` | Meaning |
|---|---|
| `bad_request` | Unknown `type`, missing or invalid field (including a missing or invalid `id`) |
| `duplicate_id` | The `id` is already in use by a command still in flight |
| `invalid_state` | The command doesn't fit the current calls (e.g. `swap` with one call) |
| `unsupported` | The phone doesn't support it (e.g. `merge` when `hello.hfp.chld` has no `3`) |
| `hfp_unavailable` | The phone's Bluetooth control link is down |
| `phone_error` | The phone answered `ERROR` |
| `timeout` | The phone didn't answer, or the expected state change didn't happen in time |
| `buffer_full` | More than 60 s of uplink audio queued; the excess was dropped. Sent with `id: null`, once per overflow. |

## Caller ID

Bluetooth first, kiosk as the fallback:

1. Ringing is detected from whichever source reports it first: HFP
   (`+CIEV` callsetup, `RING`) or the kiosk's `call.incoming` event.
2. The number is taken from HFP when the phone provides it (`+CLIP`, or
   `AT+CLCC` while ringing). Otherwise the kiosk's number is used. (The
   kiosk's watcher posts to the host's `/api/internal/event?serial=<adb
   serial>`; all phones share the host's port 8081 over `adb reverse`.)
3. `call.incoming` is sent once the number is known, or after 2 s with
   `number: null` if neither source has it by then. A number that arrives
   later is sent as a `call.state` update.

So a client can make its allowlist decision on `call.incoming`, and treat
`number: null` as an unknown caller.

## Audio rules

- **Downlink:** if the client reads too slowly, the server drops the oldest
  frames. It never disconnects the client.
- **Uplink:** played in 20 ms steps, padded with silence when the queue is
  empty, so marks fire within ~20 ms of the real playback position. The
  client may send audio faster than real time (a realtime model does); it
  queues, up to 60 s.
- **The uplink is one queue from one owner.** It plays whatever the client
  sends: model speech, a pre-recorded clip, live audio from somewhere else.
  otacon does no mixing. A client that wants two sources at once (say, a quiet
  sound under speech) mixes them itself before sending.
- **The audio is not tied to a call.** It is whatever the phone routes:
  ringback while an outgoing call is ringing, the active call afterwards,
  silence while every call is held. Uplink audio only reaches the active
  call; a held party hears silence.

### Interruptions (barge-in)

When the other party starts talking over the model, the client sends
`clear`. otacon drops everything still queued and acks with
`{"droppedMs": 1840}`, the length of queued audio that was never played.
Audio actually heard = audio sent − `droppedMs`, which is what the client
needs to tell the model where its reply was cut off (OpenAI:
`conversation.item.truncate`). Marks that were in the dropped audio come back
with `cleared: true`.

### Marks

Marks are inserted by the client, not the model. A typical client sends one
right after the last audio of each model reply. The echo tells it the reply
has actually been heard, so it can safely run the next step (put the call on
hold, swap, merge, hang up).

## Read-only clients

`ws/voice/monitor` is the one read-only endpoint, for any number of listeners
(the web page's Listen button, `otacon call listen`, recorders, transcribers).

- **Events:** `hello` (without `hfp`, which is about commands) and every call event:
  `call.incoming`, `call.state`, `call.ended`, `audio.link`, `hfp`. It does
  not see `ack`, `error` or `mark`, which belong to the controlling client.
- **Audio:** stereo, `pcm_s16le`, at the call's rate (16 kHz on the
  Bluetooth backend; read `hello.audio.sampleRate`), channels interleaved
  (L, R, L, R, …), 20 ms per frame (1280 bytes):
  - left: the other party (what the phone hears);
  - right: exactly what otacon plays into the phone's call audio, sample for
    sample and at the moment it is played: whatever the `ws/voice/control`
    owner sent, including silence when its queue is empty. Audio dropped by
    `clear` never appears, because it was never played.

  The two sides are sample-aligned, so a recording or transcript can keep
  them apart and in sync. A listener that wants one stream averages L and R.
- **Sync:** events and audio arrive in timeline order, each event with
  `audioPos`, the same as on `ws/voice/control`.
- **Read-only:** a command sent here is answered with `error` `bad_request`
  (with its `id` if it had a valid one). Listening never
  takes control from the `ws/voice/control` owner, and shares its capture,
  so listeners never compete for the Bluetooth audio device.
- `hello.audio` says `"channels": 2` and names them:
  `"channelMap": ["remote", "local"]`.

## Example: put the business on hold and bring a person in

```
→ {"type":"mark","name":"hold-msg"}                  (after "please hold" audio)
← {"type":"mark","name":"hold-msg","cleared":false}
→ {"type":"hold","id":"2"}                       ← ack 2, call.state call_a held
→ {"type":"dial","id":"3","to":"+15550001111"}   ← ack 3 {call call_b}
← call.state call_b dialing → alerting → active
   … talk to the person …
→ {"type":"swap","id":"4"}                       ← call.state call_b held, call_a active
   … tell the business the person is joining, then mark and wait for it …
→ {"type":"merge","id":"5"}                      ← call.state call_a/call_b conference: true
```

## REST

Every call-control command also exists as REST, for the CLI and scripts. They
use the same controller and checks as the socket and work while a socket
client is connected. The resulting state changes show up on the socket.

| Endpoint | Same as command |
|---|---|
| `POST /phones/{id}/api/calls/dial` `{to}` | `dial` |
| `POST …/calls/answer`, `…/calls/reject` | `answer`, `reject` |
| `POST …/calls/hangup` `{call?}` | `hangup` |
| `POST …/calls/hold`, `…/resume`, `…/swap`, `…/merge` | `hold`, `resume`, `swap`, `merge` |
| `POST …/calls/dtmf` `{digits}` | `dtmf` |
| `GET …/calls/status` | `status`: `{calls: [...], hfp: {connected, chld}}` |

`answer`, `reject` and `hangup` take an optional `{call}` body. A command
returns `{"ok": true, ...}` with the same fields as its `ack.result`; an error
returns `{"error": code, "message": ...}` with the HTTP status for its code:
`bad_request` 400, `invalid_state` 409, `unsupported` 422, `phone_error` 502,
`hfp_unavailable` 503, `timeout` 504.

When the phone's Bluetooth control link is down, `dial`, `answer` and `hangup`
fall back to today's ADB behaviour and return `"fallback": "adb"` (no state
check); the others fail with `hfp_unavailable`. `status` then returns the
last known calls, as reported by the kiosk's call watcher. Audio is only
available on the socket.

## Other endpoints

| Endpoint | Change |
|---|---|
| `/ws/audio/call` | Removed (replaced by `ws/voice/control`) |
| `/ws/events` | Stays the read-only feed of every phone event, for any number of listeners: `call.incoming` / `call.state` / `call.ended` (identical to the voice sockets' ones), `sms.received`, `audio.sink.active` / `inactive`. **The envelope changes** from `{"event": …, "data": …}` to the voice sockets' `{"type": …, "ts": …, …}`, with the old `data` fields moved to the top level. The kiosk's `call.connected` and the server's `call.dialing` go away. It exists so the CLI, the web page and other watchers can follow calls without taking control from the `ws/voice/control` owner or receiving its audio. |
| `/audio` (live MP3 of call audio) | Removed. Nothing used it; `ws/voice/monitor` and `otacon call listen` cover listening. |
| `/ws/audio/media` | Renamed to `/ws/media`, otherwise unchanged. It is the phone's media playback over the separate A2DP link (phone → Pi only, 44.1 kHz stereo), a different device and format from call audio (HFP, both directions, 16 kHz mono). Binary frames carry no stream tag, so one socket can only carry one format. No call audio, ringback or hold music ever travels over A2DP. |
| `/ws/record` | Unchanged. Screen recording: a status message every second, then the whole MP4 in one binary message. |

## CLI

- `otacon call status` lists every call (id, number, direction, state,
  conference).
- New: `otacon call reject | hold | resume | swap | merge`, and
  `otacon call dtmf <digits>`.
- `otacon call hangup [--call <id>]`.
- New: `otacon call listen [--out file.wav]` plays the call (both sides) from
  `ws/voice/monitor`, or saves it as a stereo WAV.
- API types regenerated from the OpenAPI spec, and `skills/otacon-cli/SKILL.md`
  updated.

## Web page

The Pi's built-in page (`src/server/static/index.html`) is the other client
besides the CLI. It changes as follows:

| On the page | Uses today | Change |
|---|---|---|
| Call "Listen" | `/ws/audio/call` (takes the exclusive call socket) | `ws/voice/monitor`, playing both sides in stereo |
| Media "Listen" | `/ws/audio/media` | `/ws/media` (renamed, same content) |
| Incoming-call banner, call strip, SMS notice | `/ws/events`: `call.incoming`, `call.connected`, `call.ended`, `call.dialing`, `sms.received` | The new `call.incoming` / `call.state` / `call.ended` events and the new envelope (see `/ws/events` above). The call strip updates from events instead of polling. |
| Dial / Answer / Hang up buttons, call strip | REST `calls/dial`, `answer`, `hangup`, `status` | Same paths. The strip shows every call from `calls`. |

The registry admin UI and the orchestrator web UI use none of these
endpoints.

## Documentation to update with the implementation

- `docs/api/asyncapi.yaml`: add the `ws/voice/control` and `ws/voice/monitor` channels
  and their messages, remove `/ws/audio/call`, and describe the `/ws/events`
  messages.
- `docs/api/README.md`: same changes. `/ws/events` is no longer "future".
- OpenAPI (code-first via `utoipa`): the new REST call endpoints, the
  `calls` array in `status`, and `/audio` removed.

## Notes

- **Caller ID per phone (tested 2026-10-17):** the Pixels show the ringing
  call's number in `AT+CLCC`. On the Samsung (phone-2), neither
  `RING`/`+CLIP` nor `AT+CLCC` showed it over HFP, so it relies on the kiosk
  fallback.
