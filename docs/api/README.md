# Otacon API Reference

Otacon exposes a REST API and WebSocket endpoints for controlling Android phones connected to a Raspberry Pi via USB.

## Quick Start

```bash
# Screenshot
curl -k https://otacon-pi.<tailnet>.ts.net:8080/phones/<phone-id>/api/screenshot -o screen.png

# Accessibility tree
curl -k https://otacon-pi.<tailnet>.ts.net:8080/phones/<phone-id>/api/snapshot

# Tap an element
curl -k -X POST -H 'Content-Type: application/json' \
  -d '{"action":"tap","ref":"e5"}' \
  https://otacon-pi.<tailnet>.ts.net:8080/phones/<phone-id>/api/action

# Device info
curl -k https://otacon-pi.<tailnet>.ts.net:8080/phones/<phone-id>/api/info
```

The host is multi-phone. Per-phone API paths are nested under
`/phones/{id}/api/...`. The CLI resolves the active registry phone to the
host-local phone id automatically.

## Specs

- **REST API**: `/api/docs/openapi.json` on the host, with a checked-in snapshot at [openapi.json](openapi.json)
- **WebSocket API**: [asyncapi.yaml](asyncapi.yaml) (AsyncAPI 3.0)
- **Voice protocol** (call control and call audio sockets, REST call commands): [voice-ws.md](../voice-ws.md)

## REST Endpoints

### Screen
| Method | Path | Description |
|--------|------|-------------|
| GET | `/phones/{id}/api/screenshot` | Phone screen as PNG |
| GET | `/phones/{id}/api/snapshot?format=text\|json` | Accessibility tree with element refs |
| GET | `/phones/{id}/api/info` | Device model, activity, resolution, backend status |

### Actions (`POST /phones/{id}/api/action`)
| Action | Required Fields | Description |
|--------|----------------|-------------|
| `tap` | `{x, y}` or `{ref}` | Tap at coordinates or element ref |
| `long_tap` | `{x, y}` or `{ref}` | Long press |
| `swipe` | `{x1, y1, x2, y2}` | Swipe gesture (optional `duration_ms`, default 300) |
| `pinch` | `{x, y, start_radius, end_radius}` | Zoom in/out (optional `duration_ms`, default 500) |
| `key` | `{key}` | Press key: home, back, enter, power, etc. |
| `type` | `{text}` | Type text (ASCII only) |
| `set_text` | `{ref, text}` | Set text on element (Unicode support) |
| `scroll_forward` | `{ref}` | Scroll down |
| `scroll_backward` | `{ref}` | Scroll up |

### Notifications
| Method | Path | Description |
|--------|------|-------------|
| GET | `/phones/{id}/api/notifications` | List with action buttons |
| DELETE | `/phones/{id}/api/notifications/{key}` | Dismiss |
| POST | `/phones/{id}/api/notifications/{key}/action/{index}` | Trigger action button |

### Clipboard
| Method | Path | Description |
|--------|------|-------------|
| GET | `/phones/{id}/api/clipboard` | Get clipboard text |
| PUT | `/phones/{id}/api/clipboard` | Set clipboard text |

### SMS
| Method | Path | Description |
|--------|------|-------------|
| GET | `/phones/{id}/api/sms/threads` | List conversation threads |
| GET | `/phones/{id}/api/sms/threads/{thread_id}/messages` | Messages in a thread |
| POST | `/phones/{id}/api/sms/messages` | Send SMS `{to, body}` |

### Calls
Call control over Bluetooth HFP. These are the REST twins of the
`ws/voice/control` commands: same controller, same state checks, serialized
per phone with the socket's commands, and usable while a socket client is
connected. Resulting state changes show up on the voice sockets and on
`/ws/events`. Call audio is only available on the sockets. See
[voice-ws.md](../voice-ws.md) for the call model and command semantics.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/phones/{id}/api/calls/dial` | `{to}` | Place a call to an E.164 number. An active call is put on hold first. Returns `{ok, call}` |
| POST | `/phones/{id}/api/calls/answer` | `{call?}` | Answer the ringing call (a call waiting behind an active call is answered by holding the active one). Returns `{ok, call}` |
| POST | `/phones/{id}/api/calls/reject` | `{call?}` | Decline the ringing call |
| POST | `/phones/{id}/api/calls/hangup` | `{call?}` | End a call, default the active call. Ending one leg of a merged call ends the whole merged call |
| POST | `/phones/{id}/api/calls/hold` | — | Put the active call on hold. Returns `{ok, calls}` |
| POST | `/phones/{id}/api/calls/resume` | — | Make the held call active (only when nothing is active). Returns `{ok, calls}` |
| POST | `/phones/{id}/api/calls/swap` | — | Swap one active and one held call. Returns `{ok, calls}` |
| POST | `/phones/{id}/api/calls/merge` | — | Join the active and held calls into one merged call. Returns `{ok, calls}` |
| POST | `/phones/{id}/api/calls/dtmf` | `{digits}` | Send keypad digits on the active call: `0-9 * # A-D`, `w` waits 500 ms. Returns `{ok, digits}` after the last digit |
| GET | `/phones/{id}/api/calls/status` | — | Every call, re-read from the phone: `{calls: [...], hfp: {connected, chld}}` |

`{call}` is a call id from `status` or an event (e.g. `call_7f3a9c`); without
it, `answer`/`reject` pick the only ringing call and `hangup` the active one.
Each call in `call`/`calls` is the same Call object as on the sockets (`id`,
`number`, `numberSource`, `direction`, `state`, `conference`, `startedAt`,
`answeredAt`).

A command returns `{"ok": true, ...}` with the same fields as the socket's
`ack.result`, once the phone has carried it out and the new state is visible.
Errors return `{"error": <code>, "message": <text>}`:

| `error` | HTTP | Meaning |
|---------|------|---------|
| `bad_request` | 400 | Missing or invalid field |
| `invalid_state` | 409 | The command doesn't fit the current calls (e.g. `merge` without one active and one held call) |
| `unsupported` | 422 | The phone doesn't support it (e.g. `merge` when `hfp.chld` has no `3`) |
| `phone_error` | 502 | The phone answered `ERROR` |
| `hfp_unavailable` | 503 | The phone's Bluetooth control link is down |
| `timeout` | 504 | The phone didn't answer, or the expected state change didn't happen in time |

When the Bluetooth control link is down, `dial`, `answer` and `hangup` fall
back to ADB (`am start -a android.intent.action.CALL`, `KEYCODE_CALL`,
`KEYCODE_ENDCALL`) and return `{"ok": true, "fallback": "adb"}` without a
state check or `call`. The other commands fail with `hfp_unavailable`, and
`status` returns the last known calls as reported by the kiosk's call watcher.

```bash
curl -k -X POST -H 'Content-Type: application/json' \
  -d '{"to":"+15550001111"}' \
  https://otacon-pi.<tailnet>.ts.net:8080/phones/<phone-id>/api/calls/dial
# {"ok":true,"call":{"id":"call_7f3a9c","number":"+15550001111","numberSource":"hfp",
#   "direction":"outgoing","state":"dialing","conference":false,"startedAt":1792204710222}}

curl -k -X POST https://otacon-pi.<tailnet>.ts.net:8080/phones/<phone-id>/api/calls/merge
# HTTP 409 {"error":"invalid_state","message":"merge needs one active and one held call"}
```

### Apps
| Method | Path | Description |
|--------|------|-------------|
| GET | `/phones/{id}/api/apps` | List installed apps |
| GET | `/phones/{id}/api/apps/running` | Foreground apps |
| POST | `/phones/{id}/api/apps/running` | Launch `{package}` |
| DELETE | `/phones/{id}/api/apps/running/{package}` | Force stop |

### Contacts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/phones/{id}/api/contacts?q=search` | Search contacts |

### Wi-Fi
| Method | Path | Description |
|--------|------|-------------|
| GET | `/phones/{id}/api/wifi` | Get host-local desired state plus observed Wi-Fi status |
| PUT | `/phones/{id}/api/wifi` | Turn Wi-Fi on/off immediately `{enabled}` and persist host-local state |

Wi-Fi is intentionally host-local. The central registry config does not own
Wi-Fi state; it only owns fleet-level Bluetooth pairing policy.

### SIMs
| Method | Path | Description |
|--------|------|-------------|
| GET | `/phones/{id}/api/sims` | List physical SIMs and eSIM profiles |
| POST | `/phones/{id}/api/sims/install` | Install eSIM `{activationCode}` |
| POST | `/phones/{id}/api/sims/delete` | Delete eSIM `{subId}` |
| POST | `/phones/{id}/api/sims/switch` | Switch active subscription `{subId}` |
| POST | `/phones/{id}/api/sims/enable` | Enable/disable profile `{subId, enabled}` |
| GET | `/phones/{id}/api/sims/defaults` | Get default SMS/voice/data subscription ids |
| PUT | `/phones/{id}/api/sims/defaults` | Set default SMS/voice/data subscription ids |

### APNs
| Method | Path | Description |
|--------|------|-------------|
| GET | `/phones/{id}/api/apns` | List device-owner APN overrides |
| POST | `/phones/{id}/api/apns` | Create an APN override |
| PUT | `/phones/{id}/api/apns/{apn_id}` | Update an APN override |
| DELETE | `/phones/{id}/api/apns/{apn_id}` | Delete an APN override |
| GET | `/phones/{id}/api/apns/enabled` | Check whether override APNs are enabled |
| PUT | `/phones/{id}/api/apns/enabled` | Enable or disable override APNs |

APN create/update bodies support data fields (`entryName`, `operatorNumeric`,
`apn`, `types`, `protocol`, `roamingProtocol`, `authType`, `user`, `password`)
and MMS fields (`mmsc`, `mmsProxy`, `mmsPort`).

The CLI and device-owner bridge auto-add APN type `mms` when MMS fields are
present.

## Internal endpoints

These are served on the host's `INTERNAL_PORT` (default `8081`) — the loopback
listener that's reachable from each phone via ADB-reverse, not from external
clients.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/watchdog-probe` | Liveness probe for the kiosk watchdog. Returns `{"ok":true,"ts":"<rfc3339>"}`. No auth, no DB hit. The kiosk hits this every 60s; 3 consecutive failures trigger a self-reboot. See [device-owner.md → Self-healing watchdog](../device-owner.md). |

The shared `tcp:8081 ↔ 8081` ADB reverse is set up per phone by
`fleet_agent/steps/snapshot.py` so every kiosk uses the same hardcoded probe URL
regardless of its own per-phone allocated port.

## WebSocket Endpoints

All WebSocket endpoints are per phone, under `wss://<host>:8080/phones/{id}/ws/`.

| Endpoint | Clients | Carries |
|----------|---------|---------|
| `/phones/{id}/ws/voice/control[?takeover=1]` | One interactive owner | Call commands, call events, full-duplex call audio |
| `/phones/{id}/ws/voice/monitor` | Any number, read-only | Call events + both sides of the call in stereo |
| `/phones/{id}/ws/media` | Any number, read-only | Phone media playback (A2DP) |
| `/phones/{id}/ws/events` | Any number, read-only | Every phone event: calls, SMS, Bluetooth audio sinks, HFP link |

The voice protocol (v1) is specified in [voice-ws.md](../voice-ws.md); the
summary below is for orientation only. `/ws/audio/call` and the `/audio` MP3
stream are removed; `/ws/audio/media` is now `/ws/media`.

### `/phones/{id}/ws/voice/control` — Call control and call audio
One owner per phone. A second connection is refused with HTTP 409; with
`?takeover=1` the server closes the existing socket (close code 4001) and
accepts the new one. Closing the socket never hangs up a call; a client that
reconnects gets the current calls in `hello`.

- **Text frames** are JSON objects with a `type` field. Every server message
  carries `ts` (epoch ms) and `audioPos` (audio samples sent on this socket
  before the message), and text and audio go out in timeline order, so an
  event arrives at its point in the audio.
- **Binary frames** are `pcm_s16le` mono at `hello.audio.sampleRate` (16000):
  server → client is what the phone hears, 20 ms per frame; client → server
  is what the other party should hear, any length, queued (up to 60 s) and
  played at real time.

Server → client: `hello` (once, on connect), `call.incoming`, `call.state`,
`call.ended`, `audio.link`, `hfp`, `mark`, `ack`, `error`.

Client → server: `dial {to}`, `answer {call?}`, `reject {call?}`,
`hangup {call?}`, `hold`, `resume`, `swap`, `merge`, `dtmf {digits}`,
`mark {name}`, `clear`, `status`. Every command except `mark` carries a
client-chosen `id` (1–64 characters) and gets exactly one reply, `ack` or
`error` with that `id`. An `ack` means the phone carried the command out and
every `call.state` it caused has already been sent. `mark`'s reply is the
`mark` event with the same `name`; `clear` drops queued uplink audio (barge-in)
and acks with `{droppedMs}`.

Error codes: `bad_request`, `duplicate_id`, `invalid_state`, `unsupported`,
`hfp_unavailable`, `phone_error`, `timeout`, `buffer_full`.

```
← {"type":"hello","protocol":1,"phoneId":"phone-r5ct60sd","number":"+15550100000",
   "audio":{"format":"pcm_s16le","sampleRate":16000,"channels":1,"frameMs":20},
   "audioLink":false,"hfp":{"connected":true,"chld":["0","1","1x","2","2x","3"]},
   "calls":[],"ts":1792204700000,"audioPos":0}
→ {"type":"dial","id":"1","to":"+15550001111"}
← {"type":"call.state","call":{"id":"call_7f3a9c","state":"dialing",...},"ts":...,"audioPos":0}
← {"type":"ack","id":"1","result":{"call":{"id":"call_7f3a9c",...}},"ts":...,"audioPos":0}
← {"type":"call.state","call":{"id":"call_7f3a9c","state":"alerting",...},...}
← {"type":"call.state","call":{"id":"call_7f3a9c","state":"active","answeredAt":...},...}
```

### `/phones/{id}/ws/voice/monitor` — Listen to calls (read-only)
For any number of listeners (web page Listen, `otacon call listen`,
recorders). Never takes control from the `ws/voice/control` owner.

- Events: `hello` (without `hfp`; `audio.channels` is 2 and
  `audio.channelMap` is `["remote","local"]`), `call.incoming`, `call.state`,
  `call.ended`, `audio.link`, `hfp`, each with `ts` and `audioPos`.
- Audio: stereo `pcm_s16le` at `hello.audio.sampleRate` (16 kHz),
  interleaved L/R, 20 ms frames (1280 bytes at 16 kHz). Left is the other party; right is exactly what otacon plays into
  the call. The two sides are sample-aligned.
- Commands are rejected with `error`, `code: bad_request`.

### `/phones/{id}/ws/media` — Media Audio (A2DP)
Subscribe-only PCM from phone media playback (formerly `/ws/audio/media`,
otherwise unchanged). This is the separate A2DP link, phone → Pi only; no call
audio, ringback or hold music ever travels over it.

**Protocol:**
1. Server sends config: `{"type":"config","sampleRate":44100,"channels":2}`
2. Server streams 4096-byte PCM frames (S16_LE, 44.1kHz stereo interleaved)

### `/phones/{id}/ws/events` — Phone events
Subscribe-only feed of every phone event, for any number of listeners. Use it
to follow calls without taking control from the `ws/voice/control` owner or
receiving its audio. On connect the server sends `audio.sink.active` for each
currently active sink, then events as they happen. Anything the client sends
is ignored.

Every message is `{"type": ..., "ts": <epoch ms>, ...fields}`. (The old
`{"event": ..., "data": ...}` envelope is gone; its `data` fields are now at
the top level.)

| `type` | Fields | When |
|--------|--------|------|
| `call.incoming` | `call` | A call starts ringing (same as on the voice sockets, without `audioPos`) |
| `call.state` | `call` | Any change to one call |
| `call.ended` | `call`, `reason`, optional `cause` | A call is gone; `reason` is `local`, `rejected`, `remote`, `failed` or `unknown` |
| `sms.received` | `from`, `body` | The kiosk saw a new SMS |
| `audio.sink.active` | `profile` (`hfp`/`a2dp`), `codec`, `sampleRate`, `channels` | A Bluetooth audio stream started |
| `audio.sink.inactive` | `profile` | A Bluetooth audio stream stopped |
| `hfp` | `connected` | The phone's Bluetooth control link went up or down |
| `audio.link` | `up` | The Bluetooth call audio link opened or closed |

```json
{"type":"call.incoming","ts":1792204800000,"call":{"id":"call_2b81d0","number":"+15550001111","numberSource":"kiosk","direction":"incoming","state":"incoming","conference":false,"startedAt":1792204799400}}
{"type":"sms.received","ts":1792204860000,"from":"+15550001111","body":"hello"}
```

The kiosk's `call.connected` and the server's `call.dialing` events no longer
exist; follow `call.state` instead.

## Audio Format

All audio is raw PCM, signed 16-bit little-endian (S16_LE). No headers or framing — the entire WebSocket binary message is audio data.

| Stream | Endpoint | Sample Rate | Channels | Frame |
|--------|----------|-------------|----------|-------|
| Call, downlink (HFP) | `ws/voice/control` | 16,000 Hz | 1 (mono) | 20 ms, 640 bytes |
| Call, uplink (HFP) | `ws/voice/control` (client → server) | 16,000 Hz | 1 (mono) | Any length |
| Call, both sides | `ws/voice/monitor` | 16,000 Hz | 2 (L remote, R local) | 20 ms, 1280 bytes |
| Media (A2DP) | `ws/media` | 44,100 Hz | 2 (stereo) | 4096 bytes, 1024 pairs |

Call rates are for the Bluetooth audio backend (the USB sound card backend
runs call audio at 44,100 Hz mono). The server dictates the format:
`hello.audio` on the voice sockets, the `config` message on `ws/media`.
Clients must send audio matching it; there is no negotiation.

## Element Refs

The accessibility tree assigns ref IDs (`e0`, `e1`, `e2`, ...) to interactive elements. Refs are:
- **Monotonic**: IDs only increase, never reuse
- **Stable**: same UI state produces same refs across snapshots
- **Fingerprinted**: path + bounds + class + text + resource-id
- **Interactive only**: clickable, long-clickable, checkable, scrollable, or EditText

Use refs with `tap`, `long_tap`, `set_text`, `scroll_forward`, `scroll_backward` actions.

## Authentication

No authentication required. The server is intended to run on a private Tailscale network. Auth will be added in a future relay server phase.
