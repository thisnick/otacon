---
name: otacon-cli
description: Control an Android phone remotely via the Otacon API. Use when automating phone interactions — tapping UI elements, typing text, reading SMS, managing apps, taking screenshots, reading the accessibility tree, handling notifications, or managing the clipboard. Triggers on tasks involving phone automation, Android control, UI testing, or mobile device management.
license: MIT
metadata:
  author: otacon
  version: "1.0.0"
---

# Otacon CLI

Control an Android phone connected to a Raspberry Pi via USB. Otacon exposes a REST API for UI automation, SMS, notifications, clipboard, apps, and contacts — plus WebSocket streams for call and media audio.

## Connection

Set the server URL via environment variable or `--host` flag:

```bash
export OTACON_HOST=https://otacon-pi:8080
```

The server uses a self-signed TLS certificate on a private Tailscale network. No authentication is required.

## Core Workflow

The typical automation loop is:

1. **Observe** — take a screenshot and/or read the accessibility tree
2. **Decide** — identify the element to interact with using ref IDs
3. **Act** — tap, type, scroll, or perform other actions
4. **Verify** — take another snapshot to confirm the result

## Element Refs

The accessibility tree assigns ref IDs (`e0`, `e1`, `e2`, ...) to interactive elements. Refs are:

- **Monotonic** — IDs only increase, never reuse across snapshots
- **Stable** — same UI state produces the same refs
- **Interactive only** — assigned to clickable, long-clickable, checkable, scrollable, or EditText elements

Use refs with `tap`, `long-tap`, `set-text`, `scroll` commands instead of raw coordinates when possible.

## Commands

### Screen Observation

```bash
# Take a screenshot (PNG to stdout or file)
otacon screenshot -o screen.png

# Get accessibility tree as indented text
otacon snapshot

# Get accessibility tree as JSON (for programmatic use)
otacon snapshot --json

# Device info (model, current activity, resolution, backend status)
otacon info
```

### UI Actions

```bash
# Tap by element ref (preferred)
otacon tap e5

# Tap by coordinates
otacon tap 540 1200

# Long-tap
otacon long-tap e5
otacon long-tap 540 1200

# Type text (ASCII only, uses ADB input)
otacon type "hello world"

# Set text on an EditText element (Unicode support)
otacon set-text e3 "Hello, world!"

# Press a key (home, back, enter, power, volume_up, volume_down, tab, delete, etc.)
otacon key home
otacon key back
otacon key enter

# Swipe gesture (x1 y1 x2 y2, optional --duration)
otacon swipe 540 1500 540 500
otacon swipe 540 1500 540 500 --duration 500

# Pinch gesture (center x, center y, start radius, end radius)
otacon pinch 540 1200 100 300    # zoom in
otacon pinch 540 1200 300 100    # zoom out

# Scroll a scrollable element
otacon scroll e7           # scroll down (forward)
otacon scroll e7 --up      # scroll up (backward)
```

### SMS

```bash
# List conversation threads
otacon sms list

# Read messages in a thread
otacon sms read <thread_id>

# Send an SMS
otacon sms send "+1234567890" "Hello from otacon"
```

### Notifications

```bash
# List current notifications (includes action buttons)
otacon notifications list

# Dismiss a notification by key
otacon notifications dismiss "<notification_key>"

# Trigger a notification action button (e.g., Reply, Mark as read)
otacon notifications action "<notification_key>" <action_index>
```

Notification keys often start with special characters. Use `--` before the key if it starts with a dash:

```bash
otacon notifications dismiss -- "0|com.example|123|null|10045"
```

### Clipboard

```bash
# Get clipboard text
otacon clipboard get

# Set clipboard text
otacon clipboard set "copied text"
```

### Apps

```bash
# List installed apps
otacon apps list

# List running/foreground apps
otacon apps running

# Launch an app by package name
otacon apps launch com.android.chrome

# Force stop an app
otacon apps stop com.android.chrome
```

### Screen Recording

```bash
# Interactive: holds TTY, shows progress, Ctrl+C to stop
otacon record                    # 30s max, saves to recording.mp4
otacon record -d 60              # 60s max
otacon record -d 60 -o video.mp4 # custom output

# Headless (for agents):
otacon record start              # start recording, 30s max
otacon record start -d 60        # start recording, 60s max
otacon record status             # check if recording + elapsed time
otacon record stop               # stop and save to recording.mp4
otacon record stop -o video.mp4  # stop and save to custom path
```

Records video + audio (mp4). Max duration 180s, default 30s. One recording at a time. Auto-stops at max duration — call `record stop` to retrieve the file.

### Open URI

```bash
# Open a URL in the registered app (browser, deep link, etc.)
otacon open "https://www.xiaohongshu.com/explore/123"

# Open a phone number in the dialer
otacon open "tel:+1234567890"

# Open an app deep link
otacon open "instagram://user?username=example"
```

### Screen Recording

```bash
# Interactive: holds TTY, shows progress, Ctrl+C to stop
otacon record                    # 30s max, saves to recording.mp4
otacon record -d 60              # 60s max
otacon record -d 60 -o video.mp4 # custom output

# Headless (for agents):
otacon record start              # start recording, 30s max
otacon record start -d 60        # start recording, 60s max
otacon record status             # check if recording + elapsed time
otacon record stop               # stop and save to recording.mp4
otacon record stop -o video.mp4  # stop and save to custom path
```

Recording is video only (h264 mp4, no audio). Max duration is 180s. Only one recording at a time. If not stopped explicitly, recording auto-stops at the max duration — call `record stop` to retrieve the file.

### Contacts

```bash
# Search contacts by name
otacon contacts search "John"
```

## WebSocket Events

Subscribe to real-time events via WebSocket at `wss://otacon-pi:8080/ws/events`. The server sends JSON text messages with `{event, data}` structure. On connect, the current state of all active audio sinks is sent.

| Event | Description |
|-------|-------------|
| `audio.sink.active` | Bluetooth audio sink became active (call started, media playing). Includes `profile`, `codec`, `sampleRate`, `channels`. |
| `audio.sink.inactive` | Bluetooth audio sink became inactive. Includes `profile`. |
| `notification.received` | New notification on phone |
| `notification.removed` | Notification dismissed |
| `call.incoming` | Incoming phone call |
| `app.foreground` | App came to foreground |

## Tips

- Prefer **ref-based actions** (`tap e5`) over coordinate-based (`tap 540 1200`) — refs are stable across screen sizes and orientations.
- Use `snapshot --json` for programmatic parsing; use `snapshot` (text) for quick visual inspection.
- After performing an action, the snapshot cache is invalidated. Take a new snapshot to see updated refs.
- The `type` command only supports ASCII. For Unicode text, use `set-text` with an element ref.
- Screenshots are full-resolution PNG. Pipe to image tools or save with `-o`.
