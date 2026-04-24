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

## WebSocket Endpoints

### `/ws/audio/call` — Call Audio (HFP)
Bidirectional PCM for phone calls.

**Protocol:**
1. Server sends config: `{"type":"config","sampleRate":16000,"channels":1}`
2. Server streams 4096-byte PCM frames (S16_LE, 16kHz mono)
3. Client may send matching PCM frames (only one sender at a time)

### `/ws/audio/media` — Media Audio (A2DP)
Subscribe-only PCM from phone media playback.

**Protocol:**
1. Server sends config: `{"type":"config","sampleRate":44100,"channels":2}`
2. Server streams 4096-byte PCM frames (S16_LE, 44.1kHz stereo interleaved)

### `/ws/events` — Events (future)
Subscribe-only real-time events for notifications, calls, app changes.

## Audio Format

All audio is raw PCM, signed 16-bit little-endian (S16_LE). No headers or framing — the entire WebSocket binary message is audio data.

| Stream | Sample Rate | Channels | Frame Size | Samples/Frame |
|--------|-------------|----------|------------|---------------|
| Call (HFP) | 16,000 Hz | 1 (mono) | 4096 bytes | 2048 |
| Media (A2DP) | 44,100 Hz | 2 (stereo) | 4096 bytes | 1024 pairs |

The server dictates the format via the `AudioConfig` message sent on connect. Clients must send audio matching this format — there is no negotiation.

## Element Refs

The accessibility tree assigns ref IDs (`e0`, `e1`, `e2`, ...) to interactive elements. Refs are:
- **Monotonic**: IDs only increase, never reuse
- **Stable**: same UI state produces same refs across snapshots
- **Fingerprinted**: path + bounds + class + text + resource-id
- **Interactive only**: clickable, long-clickable, checkable, scrollable, or EditText

Use refs with `tap`, `long_tap`, `set_text`, `scroll_forward`, `scroll_backward` actions.

## Authentication

No authentication required. The server is intended to run on a private Tailscale network. Auth will be added in a future relay server phase.
