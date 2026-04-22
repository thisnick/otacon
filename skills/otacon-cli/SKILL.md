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
otacon auth register --registry http://otacon-registry.<tailnet>.ts.net:9080

# 2. Approve from another terminal (using an existing admin token):
otacon reg list
otacon reg approve <pending_id>

# 3. Pick a default phone (avoids passing --phone every time)
otacon phone list
otacon phone use phone-2
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

The deployed CLI binary is `otacon`:

```bash
otacon <subcommand> ...
```

All examples in this skill use `otacon`.

**Inside this repo (development)**, the CLI hasn't been globally installed. Use the pnpm wrapper instead — it runs the in-tree TypeScript source:

```bash
pnpm cli <subcommand> ...     # equivalent to: otacon <subcommand> ...
```

So `otacon phone list` becomes `pnpm cli phone list` when working from inside the repo. Pick whichever matches your environment.

## Output format

List/status commands default to **column-aligned tables** with colored status fields. Pass `--json` for raw JSON (for piping to `jq` or programmatic use).

```bash
otacon phone list           # readable table
otacon phone list --json    # JSON array
```

## Fleet management

### Phones

```bash
otacon phone list                              # list all phones
otacon phone list --connected                  # only connected
otacon phone list --host otacon-pi             # filter by host
otacon phone use <phone-id>                    # set active phone (persists in config)
otacon phone delete <phone-id>                 # remove from registry (re-added on next heartbeat if alive)
otacon phone factory-reset                     # active phone (DESTRUCTIVE)
otacon phone location [<id>]                   # show host FQDN + port
otacon phone config get                        # current config (wifi, bluetooth, etc.)
```

### eSIM (per phone)

Maps directly to the host's `/api/esim/*` endpoints:

```bash
otacon phone esim list                         # GET /esim/profiles
otacon phone esim install <activation-code>    # install via SM-DP+ activation code
otacon phone esim delete <sub-id>              # delete eSIM profile
otacon phone esim switch <sub-id>              # set active subscription
otacon phone esim enable <sub-id>              # enable a profile
otacon phone esim disable <sub-id>             # disable a profile
otacon phone esim defaults                     # get default SIM for SMS/voice/data
```

### Hosts (Pi nodes)

```bash
otacon host list                               # all hosts
otacon host status <id>                        # detail for one host
otacon host delete <id>                        # forget (re-added on next heartbeat)
```

### Dongles (USB BT adapters)

```bash
otacon dongle list                             # all dongles, with phone bindings
otacon dongle delete <id>                      # forget
```

### Registrations

Both new hosts (Pi nodes) and new clients (CLIs/UIs) request registration; an admin approves them.

```bash
otacon reg list                                # pending hosts + clients
otacon reg approve <id>                        # approve any pending registration
otacon reg reject <id>                         # reject
otacon reg approve-all                         # bulk approve [--hosts-only|--clients-only]
otacon reg reject-all                          # bulk reject
```

### Admin clients (other CLIs/UIs that share access)

```bash
otacon client list                             # active admin clients
otacon client list --all                       # include revoked
otacon client revoke <token-id>                # revoke a client's access
```

### Auth

```bash
otacon auth register --registry <url>          # pair this CLI (long-polls until approved)
otacon auth unregister                         # remove local token
otacon auth whoami                             # show registry, token fingerprint, active phone
```

## Per-phone automation (top-level commands)

These operate on the active phone (set via `phone use`) or `--phone <id>`.

### Core observation loop

```bash
otacon screenshot -o screen.png                # PNG of current screen
otacon snapshot                                # accessibility tree as indented text
otacon snapshot --json                         # accessibility tree as JSON
otacon info                                    # device info (model, activity, resolution)
```

The accessibility tree assigns ref IDs (`e0`, `e1`, ...) to interactive elements. Refs are monotonic, stable for the same UI state, and only assigned to interactive elements. **Prefer ref-based actions over raw coordinates.**

### UI actions

```bash
# Tap (by ref preferred, by coords as fallback)
otacon tap e5
otacon tap 540 1200

# Long-tap
otacon long-tap e5
otacon long-tap 540 1200

# Type ASCII text (uses ADB input)
otacon type "hello world"

# Set text on an EditText (Unicode-safe)
otacon set-text e3 "Hello, world!"

# Swipe (x1 y1 x2 y2 [--duration ms])
otacon swipe 540 1500 540 500
otacon swipe 540 1500 540 500 --duration 500

# Pinch (center x, y, start radius, end radius)
otacon pinch 540 1200 100 300                  # zoom in
otacon pinch 540 1200 300 100                  # zoom out

# Scroll a scrollable element
otacon scroll e7
otacon scroll e7 --up

# Press a key
otacon key home
otacon key back
otacon key enter
```

**Recognized key names** (or pass a raw Android keycode):
- Navigation: `home`, `back`, `recents`/`app_switch`, `menu`
- Power: `power` (toggle), `wake`/`wakeup`, `sleep`
- Volume: `volume_up`, `volume_down`
- Editing: `enter`, `delete`/`backspace`, `tab`, `space`, `escape`/`esc`
- Modifiers: `ctrl`, `shift`, `alt`, `meta`/`cmd`/`search`
- Calls: `call`, `end_call`/`endcall`
- Letters: `a`–`z` (lowercase, single char)
- Raw: any digit string (e.g. `otacon key 24`)

### SMS

```bash
otacon sms list                                # threads
otacon sms read <thread_id>                    # messages in thread
otacon sms send "+1234567890" "message body"
```

### Calls

```bash
otacon call dial "+1234567890"
otacon call answer                             # answer incoming
otacon call hangup                             # end current call
otacon call status                             # state + duration
```

### Notifications

```bash
otacon notifications list                      # current notifications + action buttons
otacon notifications dismiss "<key>"
otacon notifications action "<key>" <index>    # trigger a button (e.g. Reply)
```

Keys often start with special characters — use `--` before the key if it starts with a dash:

```bash
otacon notifications dismiss -- "0|com.example|123|null|10045"
```

### Clipboard

```bash
otacon clipboard get
otacon clipboard set "copied text"
```

### Apps

```bash
otacon app list                               # installed apps
otacon app running                            # foreground / running
otacon app launch com.android.chrome
otacon app stop com.android.chrome
otacon app install /path/to/app.apk           # sideload APK
```

### Open URI / deep link

```bash
otacon open "https://example.com"
otacon open "tel:+1234567890"
otacon open "instagram://user?username=example"
```

### Contacts

```bash
otacon contacts search "John"
```

### Screen recording

```bash
# Interactive (holds TTY, Ctrl+C to stop)
otacon record                                  # 30s max, saves to recording.mp4
otacon record -d 60                            # 60s max
otacon record -d 60 -o video.mp4

# Headless (for agents)
otacon record start                            # start (30s max)
otacon record start -d 60                      # start (60s max)
otacon record status                           # check if recording + elapsed
otacon record stop                             # stop and save to recording.mp4
otacon record stop -o video.mp4
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
- **Use `otacon auth whoami`** to debug "not registered" issues — it shows which registry + token are actually being used after env var/config resolution.
