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
otacon phones list
otacon phones use phone-2
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

So `otacon phones list` becomes `pnpm cli phones list` when working from inside the repo. Pick whichever matches your environment.

## Output format

List/status commands default to **column-aligned tables** with colored status fields. Pass `--json` for raw JSON (for piping to `jq` or programmatic use).

```bash
otacon phones list          # readable table
otacon phones list --json   # JSON array
```

## Fleet management

### Phones

```bash
otacon phones list                             # list all phones
otacon phones list --connected                 # only connected
otacon phones list --host otacon-pi            # filter by host
otacon phones use <phone-id>                   # set active phone (persists in config)
otacon phones delete <phone-id>                # remove from registry (re-added on next heartbeat if alive)
otacon phones factory-reset                    # active phone (DESTRUCTIVE)
otacon phones status [<phone-id>]              # registry status + BT pairing policy
otacon phones location [<id>]                  # show host FQDN + port
otacon config get                              # registry config for active phone
otacon config set bluetooth_enabled=off        # registry-level BT pairing policy
```

### SIM/eSIM (per phone)

Maps directly to the host's `/api/sims/*` endpoints:

```bash
otacon sims list                                # all profiles (active + disabled, --json)
otacon sims install <activation-code>           # install via SM-DP+ activation code
otacon sims delete <sub-id>                     # delete eSIM profile
otacon sims switch <sub-id>                     # set active subscription
otacon sims enable <sub-id>                     # enable a profile
otacon sims disable <sub-id>                    # disable a profile
otacon sims defaults                            # get default SIM for SMS/voice/data
```

**eSIM install is platform-aware:**
- **Pixel**: uses the Settings UI flow (walks through a state machine that opens
  Settings → Add eSIM → manual code entry → confirm). This is necessary because
  `EuiccManager.downloadSubscription()` requires carrier privilege that third-party
  Device Owner apps don't have.
- **Samsung / other**: uses `EuiccManager.downloadSubscription()` via the kiosk app
  bridge with an auto-tap watcher for the carrier confirmation dialog.

After install, the profile is typically disabled. Enable + switch to activate:
```bash
otacon sims list                                # find the new subId
otacon sims enable <sub-id>
otacon sims switch <sub-id>                     # assign to SIM slot, registers with carrier
```

### APN overrides (per phone)

Maps directly to the host's `/api/apns/*` endpoints. APN ids are assigned by
Android `DevicePolicyManager.addOverrideApn()` and are shown by list/create.

```bash
otacon apns list
otacon apns upsert SpeedTalk --operator 310240 --apn stkmobi --mmsc <mms-url>
otacon apns create SpeedTalk --operator "310 240" --apn stkmobi
otacon apns update <apn-id> --types default,mms,supl --protocol ipv4v6 --mmsc <mms-url>
otacon apns delete <apn-id>
otacon apns status
otacon apns enable                              # enable override APNs globally
otacon apns disable                             # return to carrier/device APNs
```

`apns list` shows each APN row's enabled flag. The global Android override APN
switch is separate; check it with `otacon apns status`.

Defaults for minimal data APNs:
- `types`: `default,supl`
- `protocol`: `ipv4v6`
- `roamingProtocol`: `ipv4v6`
- `authType`: `none`

MMS-capable APNs also support `--mmsc`, `--mms-proxy`, and `--mms-port`.
Create/upsert auto-adds `mms` to `types` when MMS fields are present; for
manual `update`, pass `--types ...mms...` if the existing APN is not already
MMS-capable.

### Wi-Fi (per phone)

Wi-Fi is controlled directly on the active phone and persisted as host-local
Rust config. There is no user-facing `wifi connect`; provisioning owns network
selection.

```bash
otacon wifi status                              # desired + observed Wi-Fi state
otacon wifi on
otacon wifi off
otacon info                                     # observed device status
```

When `wifi off` is set, the fleet-agent monitor skips Wi-Fi setup and Wi-Fi
healing for that phone.

### Registry config

Registry config is fleet policy pushed through the central registry. Bluetooth
stays here because it controls pairing/dongle assignment intent.

```bash
otacon config get
otacon config set bluetooth_enabled=off
otacon config set bluetooth_enabled=on
```

**Adding a new UI variant for eSIM install (for agents):**

The Pixel Settings UI flow has text that varies by Android version and phone model.
When a new variant appears, use the snapshot + manual walk-through to map it:

```bash
# 1. Wake and go home
otacon key wake --phone <id>
otacon key home --phone <id>

# 2. Open the SIMs settings entry point
# (run via SSH: adb -s <serial> shell am start -a android.settings.MOBILE_NETWORK_LIST)

# 3. At each screen, capture the a11y tree
otacon snapshot --phone <id>

# 4. Find the right element and tap it
otacon tap <ref> --phone <id>
# For system dialogs that don't honor a11y clicks, use input tap via SSH:
# adb -s <serial> shell 'input tap <x> <y>'

# 5. For text entry (activation code field), use set-text
otacon set-text <ref> '<activation-code>' --phone <id>

# 6. Repeat steps 3-5 until install completes or fails
```

The state machine is in `src/server/src/api/esim_ui.rs`. Each state has a detection
predicate (text match on the snapshot) and an action (tap button, enter text, wait).
Add new variants by updating detection text and action targets.

### Hosts (Pi nodes)

```bash
otacon hosts list                              # all hosts
otacon hosts status <id>                       # detail for one host
otacon hosts delete <id>                       # forget (re-added on next heartbeat)
```

### Dongles (USB BT adapters)

```bash
otacon dongles list                            # all dongles, with phone bindings
otacon dongles delete <id>                     # forget
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
otacon clients list                            # active admin clients
otacon clients list --all                      # include revoked
otacon clients revoke <token-id>               # revoke a client's access
```

### Auth

```bash
otacon auth register --registry <url>          # pair this CLI (long-polls until approved)
otacon auth unregister                         # remove local token
otacon auth whoami                             # show registry, token fingerprint, active phone
```

## Per-phone automation (top-level commands)

These operate on the active phone (set via `phones use`) or `--phone <id>`.

### Always check screen state first

Before taking a screenshot, snapshot, or interacting with UI, run `otacon info`
and check `screen_state`. Possible values:

| `screen_state` | Meaning | Can you interact? |
|---|---|---|
| `unlocked` | Awake, no keyguard, foreground app visible | Yes — proceed |
| `locked` | Awake but lock screen showing | Snapshot/screenshot work but show lock screen, not your app |
| `asleep` | Display off, deep sleep | No — wake first |
| `dozing` | Ambient/AOD low-power display | No — wake first |
| `dreaming` | Screensaver running | No — wake first |
| `unknown` | Couldn't determine (ADB error) | Treat as asleep |

Also useful from `info`: `activity` (current foreground activity) and
`window` (focused window). When `activity` is empty/null, the phone is
likely asleep.

To wake a phone:

```bash
otacon key wake                                # power-on the screen
# Then unlock if needed (lock pattern, PIN, swipe-up — varies)
otacon swipe 540 1500 540 500                  # swipe up to dismiss lock
```

### Core observation loop

```bash
otacon info                                    # check screen_state, activity FIRST
otacon info --monitor                          # also include verbose fleet-agent monitor blob
otacon screenshot -o screen.png                # PNG of current screen
otacon snapshot                                # accessibility tree as indented text
otacon snapshot --json                         # accessibility tree as JSON
```

`info` returns: model, resolution, `screen_state`, current `activity` and
`window`, `wifi`, `bt_connected`, `vnc_port` (the host port to VNC into),
phone stats (CPU/mem/battery/temp), and `phone_number`. The
`monitor` field (verbose fleet-agent setup/health blob) is hidden by
default; pass `--monitor` to include it.

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
otacon apps list                              # installed apps (with versionCode)
otacon apps running                           # foreground / running
otacon apps launch com.android.chrome
otacon apps stop com.android.chrome
otacon apps install /path/to/app.apk          # sideload .apk (single file)
otacon apps install /path/to/app.apkm         # sideload .apkm (APKMirror AAB bundle — auto-extracts splits)
```

`apps running` returns both the apps list AND the current `screen_state`,
so when the list is empty you'll see e.g. `(no running apps — phone is
dozing. Wake with: otacon key wake)` instead of just an empty result.

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
otacon record                                  # 5min max, saves to recording.mp4
otacon record -d 60                            # 60s max
otacon record -d 60 -o video.mp4

# Headless (for agents)
otacon record start                            # start (5min max)
otacon record start -d 60                      # start (60s max)
otacon record status                           # check if recording + elapsed
otacon record stop                             # stop and save to recording.mp4
otacon record stop -o video.mp4
```

Records video + audio (mp4). Default 5min, max 10min. Only one recording at a time. Auto-stops at max — call `record stop` to retrieve the file.

## Architecture quick reference

- **Registry** (`http://otacon-registry.<tailnet>.ts.net:9080`) — central index of fleet state. Mirrors host state via reliable events (outbox + reconciler — see AGENTS.md). CLI talks here for fleet queries.
- **Host** (`https://otacon-pi.<tailnet>.ts.net:8080`) — Pi running phones. CLI talks here directly for per-phone actions, after looking up the address from the registry.
- **Resolution flow**: CLI calls `GET /admin/phones/{id}` → extracts `host.address` + `host.api_port` + maps registry phone ID to host-local ID via `adb_serial` → makes direct HTTPS call to `https://{address}:{port}/phones/{local_id}/api/...`.

## Tips for AI agents

- **Set an active phone first** (`phones use <id>`) so subsequent commands don't need `--phone`. Or pass `OTACON_PHONE=<id>` env var per invocation.
- **Always pass `--json`** when piping to `jq` or other tools. Default tables include ANSI color codes that won't parse cleanly.
- **Take a snapshot before acting** — refs are only valid for the current UI state. After a tap/scroll, take another snapshot.
- **Prefer `set-text` over `type`** for non-ASCII text or when targeting a specific input field by ref.
- **Snapshots are cached briefly** — after performing an action, the cache is invalidated. Re-snapshot to see updated state.
- **Notification keys often start with special chars** — quote them and use `--` separator.
- **`screenshot.png` saved by the wrapper goes to `src/cli/`** (the package dir), not `$PWD`. Pass an absolute path with `-o $PWD/screenshot.png` if running from a different directory.
- **Use `otacon auth whoami`** to debug "not registered" issues — it shows which registry + token are actually being used after env var/config resolution.
