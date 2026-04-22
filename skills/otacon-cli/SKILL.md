---
name: otacon-cli
description: Control Android phones in a fleet remotely via the otacon CLI. Use for phone automation — tapping UI elements, typing text, reading SMS, taking screenshots, accessibility tree, notifications, clipboard, apps, calls, eSIM, recording — and fleet management — registering this CLI client, listing/managing phones/hosts/dongles, approving registrations. Triggers on tasks involving phone automation, Android control, UI testing, mobile device management, fleet management, SIM/eSIM provisioning.
license: MIT
metadata:
  author: otacon
  version: "2.0.0"
---

# Otacon CLI

Control Android phones connected to a Raspberry Pi fleet, via a central registry. The CLI talks to the registry to discover where each phone lives, then makes per-phone calls directly to the host that owns it. Everything runs over Tailscale.

## Setup (one-time per machine)

```bash
# 1. Pair this CLI with the registry — long-polls until an admin approves
pnpm cli auth register --registry http://otacon-registry.<tailnet>.ts.net:9080

# 2. Approve from another terminal (using an existing admin token):
pnpm cli reg list
pnpm cli reg approve <pending_id>

# 3. Pick a default phone (avoids passing --phone every time)
pnpm cli phone list
pnpm cli phone use phone-2
```

After this, the token + registry URL are saved to `~/.otacon/config.toml` (chmod 0600). Subsequent commands work without flags.

### Env var overrides

All config values can be overridden per-invocation via env vars (precedence: env > flag > config file):

| Env var | Purpose |
|---|---|
| `OTACON_REGISTRY_URL` | Registry endpoint |
| `OTACON_TOKEN` | Bearer admin token |
| `OTACON_PHONE` | Active phone ID (also via `--phone <id>`) |
| `OTACON_CONFIG_DIR` | Config directory (default `~/.otacon`) |

## How to invoke

This repo uses pnpm workspaces. The CLI is invoked through a wrapper script:

```bash
pnpm cli <subcommand> ...
```

Everything after `pnpm cli` is passed as args to the otacon binary. Example: `pnpm cli phone list`.

## Output format

List/status commands default to **column-aligned tables** with colored status fields. Pass `--json` for raw JSON (for piping to `jq` or programmatic use).

```bash
pnpm cli phone list           # readable table
pnpm cli phone list --json    # JSON array
```

## Fleet management

### Phones

```bash
pnpm cli phone list                              # list all phones
pnpm cli phone list --connected                  # only connected
pnpm cli phone list --host otacon-pi             # filter by host
pnpm cli phone use <phone-id>                    # set active phone (persists in config)
pnpm cli phone delete <phone-id>                 # remove from registry (re-added on next heartbeat if alive)
pnpm cli phone factory-reset                     # active phone (DESTRUCTIVE)
pnpm cli phone location [<id>]                   # show host FQDN + port
pnpm cli phone config get                        # current config (wifi, bluetooth, etc.)
```

### eSIM (per phone)

Maps directly to the host's `/api/esim/*` endpoints:

```bash
pnpm cli phone esim list                         # GET /esim/profiles
pnpm cli phone esim install <activation-code>    # install via SM-DP+ activation code
pnpm cli phone esim delete <sub-id>              # delete eSIM profile
pnpm cli phone esim switch <sub-id>              # set active subscription
pnpm cli phone esim enable <sub-id>              # enable a profile
pnpm cli phone esim disable <sub-id>             # disable a profile
pnpm cli phone esim defaults                     # get default SIM for SMS/voice/data
```

### Hosts (Pi nodes)

```bash
pnpm cli host list                               # all hosts
pnpm cli host status <id>                        # detail for one host
pnpm cli host delete <id>                        # forget (re-added on next heartbeat)
```

### Dongles (USB BT adapters)

```bash
pnpm cli dongle list                             # all dongles, with phone bindings
pnpm cli dongle delete <id>                      # forget
```

### Registrations

Both new hosts (Pi nodes) and new clients (CLIs/UIs) request registration; an admin approves them.

```bash
pnpm cli reg list                                # pending hosts + clients
pnpm cli reg approve <id>                        # approve any pending registration
pnpm cli reg reject <id>                         # reject
pnpm cli reg approve-all                         # bulk approve [--hosts-only|--clients-only]
pnpm cli reg reject-all                          # bulk reject
```

### Admin clients (other CLIs/UIs that share access)

```bash
pnpm cli client list                             # active admin clients
pnpm cli client list --all                       # include revoked
pnpm cli client revoke <token-id>                # revoke a client's access
```

### Auth

```bash
pnpm cli auth register --registry <url>          # pair this CLI (long-polls until approved)
pnpm cli auth unregister                         # remove local token
pnpm cli auth whoami                             # show registry, token fingerprint, active phone
```

## Per-phone automation (top-level commands)

These operate on the active phone (set via `phone use`) or `--phone <id>`.

### Core observation loop

```bash
pnpm cli screenshot -o screen.png                # PNG of current screen
pnpm cli snapshot                                # accessibility tree as indented text
pnpm cli snapshot --json                         # accessibility tree as JSON
pnpm cli info                                    # device info (model, activity, resolution)
```

The accessibility tree assigns ref IDs (`e0`, `e1`, ...) to interactive elements. Refs are monotonic, stable for the same UI state, and only assigned to interactive elements. **Prefer ref-based actions over raw coordinates.**

### UI actions

```bash
# Tap (by ref preferred, by coords as fallback)
pnpm cli tap e5
pnpm cli tap 540 1200

# Long-tap
pnpm cli long-tap e5
pnpm cli long-tap 540 1200

# Type ASCII text (uses ADB input)
pnpm cli type "hello world"

# Set text on an EditText (Unicode-safe)
pnpm cli set-text e3 "Hello, world!"

# Swipe (x1 y1 x2 y2 [--duration ms])
pnpm cli swipe 540 1500 540 500
pnpm cli swipe 540 1500 540 500 --duration 500

# Pinch (center x, y, start radius, end radius)
pnpm cli pinch 540 1200 100 300                  # zoom in
pnpm cli pinch 540 1200 300 100                  # zoom out

# Scroll a scrollable element
pnpm cli scroll e7
pnpm cli scroll e7 --up

# Press a key
pnpm cli key home
pnpm cli key back
pnpm cli key enter
```

**Recognized key names** (or pass a raw Android keycode):
- Navigation: `home`, `back`, `recents`/`app_switch`, `menu`
- Power: `power` (toggle), `wake`/`wakeup`, `sleep`
- Volume: `volume_up`, `volume_down`
- Editing: `enter`, `delete`/`backspace`, `tab`, `space`, `escape`/`esc`
- Modifiers: `ctrl`, `shift`, `alt`, `meta`/`cmd`/`search`
- Calls: `call`, `end_call`/`endcall`
- Letters: `a`–`z` (lowercase, single char)
- Raw: any digit string (e.g. `pnpm cli key 24`)

### SMS

```bash
pnpm cli sms list                                # threads
pnpm cli sms read <thread_id>                    # messages in thread
pnpm cli sms send "+1234567890" "message body"
```

### Calls

```bash
pnpm cli call dial "+1234567890"
pnpm cli call answer                             # answer incoming
pnpm cli call hangup                             # end current call
pnpm cli call status                             # state + duration
```

### Notifications

```bash
pnpm cli notifications list                      # current notifications + action buttons
pnpm cli notifications dismiss "<key>"
pnpm cli notifications action "<key>" <index>    # trigger a button (e.g. Reply)
```

Keys often start with special characters — use `--` before the key if it starts with a dash:

```bash
pnpm cli notifications dismiss -- "0|com.example|123|null|10045"
```

### Clipboard

```bash
pnpm cli clipboard get
pnpm cli clipboard set "copied text"
```

### Apps

```bash
pnpm cli apps list                               # installed apps
pnpm cli apps running                            # foreground / running
pnpm cli apps launch com.android.chrome
pnpm cli apps stop com.android.chrome
pnpm cli apps install /path/to/app.apk           # sideload APK
```

### Open URI / deep link

```bash
pnpm cli open "https://example.com"
pnpm cli open "tel:+1234567890"
pnpm cli open "instagram://user?username=example"
```

### Contacts

```bash
pnpm cli contacts search "John"
```

### Screen recording

```bash
# Interactive (holds TTY, Ctrl+C to stop)
pnpm cli record                                  # 30s max, saves to recording.mp4
pnpm cli record -d 60                            # 60s max
pnpm cli record -d 60 -o video.mp4

# Headless (for agents)
pnpm cli record start                            # start (30s max)
pnpm cli record start -d 60                      # start (60s max)
pnpm cli record status                           # check if recording + elapsed
pnpm cli record stop                             # stop and save to recording.mp4
pnpm cli record stop -o video.mp4
```

Records video + audio (mp4). Max duration 180s. Only one recording at a time. Auto-stops at max — call `record stop` to retrieve the file.

## Architecture quick reference

- **Registry** (`http://otacon-registry.<tailnet>.ts.net:9080`) — central index of fleet state. Mirrors host state via reliable events. CLI talks here for fleet queries.
- **Host** (`http://otacon-pi.<tailnet>.ts.net:8080`) — Pi running phones. CLI talks here directly for per-phone actions, after looking up the address from the registry.
- **Resolution flow**: CLI calls `GET /admin/phones/{id}` → extracts `host.fqdn` + maps registry phone ID to host-local ID via `adb_serial` → makes direct HTTPS call.

## Tips for AI agents

- **Set an active phone first** (`phone use <id>`) so subsequent commands don't need `--phone`. Or pass `OTACON_PHONE=<id>` env var per invocation.
- **Always pass `--json`** when piping to `jq` or other tools. Default tables include ANSI color codes that won't parse cleanly.
- **Take a snapshot before acting** — refs are only valid for the current UI state. After a tap/scroll, take another snapshot.
- **Prefer `set-text` over `type`** for non-ASCII text or when targeting a specific input field by ref.
- **Snapshots are cached briefly** — after performing an action, the cache is invalidated. Re-snapshot to see updated state.
- **Notification keys often start with special chars** — quote them and use `--` separator.
- **`screenshot.png` saved by the wrapper goes to `src/cli/`** (the package dir), not `$PWD`. Pass an absolute path with `-o $PWD/screenshot.png` if running from a different directory.
- **Use `pnpm cli auth whoami`** to debug "not registered" issues — it shows which registry + token are actually being used after env var/config resolution.
