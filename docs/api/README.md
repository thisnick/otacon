# Otacon API Reference

Otacon exposes a REST API and WebSocket endpoints for controlling an Android phone connected to a Raspberry Pi via USB.

## Quick Start

```bash
# Screenshot
curl -k https://otacon-pi.<tailnet>.ts.net:8080/api/screenshot -o screen.png

# Accessibility tree
curl -k https://otacon-pi.<tailnet>.ts.net:8080/api/snapshot

# Tap an element
curl -k -X POST -H 'Content-Type: application/json' \
  -d '{"action":"tap","ref":"e5"}' \
  https://otacon-pi.<tailnet>.ts.net:8080/api/action

# Device info
curl -k https://otacon-pi.<tailnet>.ts.net:8080/api/info
```

## Specs

- **REST API**: [openapi.yaml](openapi.yaml) (OpenAPI 3.1)
- **WebSocket API**: [asyncapi.yaml](asyncapi.yaml) (AsyncAPI 3.0)

## REST Endpoints

### Screen
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/screenshot` | Phone screen as PNG |
| GET | `/api/snapshot?format=text\|json` | Accessibility tree with element refs |
| GET | `/api/info` | Device model, activity, resolution, backend status |

### Actions (`POST /api/action`)
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
| GET | `/api/notifications` | List with action buttons |
| DELETE | `/api/notifications/{key}` | Dismiss |
| POST | `/api/notifications/{key}/action/{index}` | Trigger action button |

### Clipboard
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/clipboard` | Get clipboard text |
| PUT | `/api/clipboard` | Set clipboard text |

### SMS
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sms/threads` | List conversation threads |
| GET | `/api/sms/threads/{id}/messages` | Messages in a thread |
| POST | `/api/sms/messages` | Send SMS `{to, body}` |

### Apps
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/apps` | List installed apps |
| GET | `/api/apps/running` | Foreground apps |
| POST | `/api/apps/running` | Launch `{package}` |
| DELETE | `/api/apps/running/{package}` | Force stop |

### Contacts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/contacts?q=search` | Search contacts |

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
