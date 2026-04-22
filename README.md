# Otacon

Infrastructure-as-code for a Raspberry Pi fleet hosting multiple Android phones — mirrors each phone's screen, provides reverse tethering, streams bidirectional audio, and locks down the devices. A central registry lets a CLI or admin UI discover and control phones across the fleet from anywhere on your tailnet.

## Architecture

- **Ansible** — bootstrap: installs Docker, system config, Tailscale, TLS certs
- **Host stack** (per Pi) — Docker containers:
  - `otacon` — phone mirroring (Xvfb + scrcpy + TigerVNC per phone), reverse tethering (gnirehtet), HTTP/WS API (`otacon-server` in Rust), fleet-agent (Python) for BT dongle pairing + device owner orchestration
  - `voice` — USB LTE dongle bridge for voice/SMS (see `docs/voice-dongle-setup.md`)
  - `watchtower` — auto-pulls new images from ghcr.io
- **Registry stack** (one per tailnet) — Docker containers on their own Tailscale identity:
  - `otacon-registry` — central index of all hosts, phones, dongles, SIMs, tokens. Serves the admin UI. Single binary, Rust + `utoipa` OpenAPI.
  - `tailscale-registry` — Tailscale sidecar (gives the registry its own FQDN like `otacon-registry.<tailnet>.ts.net`)
- **CLI** (`otacon`, TypeScript) — pair once with `otacon auth register`, then drive any phone in the fleet: `otacon phone list`, `otacon screenshot`, `otacon tap e5`, etc. See `skills/otacon-cli/SKILL.md` for the full reference.
- **Android app** — Device Owner kiosk app that locks down WiFi/Bluetooth/GPS/factory-reset and provides the ContentProvider bridge for SMS/calls/eSIM/notifications.
- **Pi-gen** — builds flashable Raspberry Pi images with everything pre-configured

## Prerequisites

- Raspberry Pi with USB sound card (see [audio wiring docs](docs/audio-connection.md))
- Android phone connected via USB (ADB debugging enabled)
- [Devbox](https://www.jetify.com/devbox) installed on your Mac
- Tailscale account with HTTPS enabled (DNS settings → MagicDNS + HTTPS)

## Quick Start

```bash
# Install toolchain
devbox install && direnv allow

# Copy and fill in your config
cp .env.example .env
# Edit .env: set VNC_PASSWORD, TS_AUTH_KEY, etc.
```

### Deploy to an existing Pi

```bash
make push              # Provision + build + push + pull + start
make health            # Verify everything is running
```

### Flash a new Pi from scratch

```bash
make pigen                             # Build image
make pigen-flash DEVICE=/dev/sdX       # Flash to SD card
make pigen-config DEVICE=/Volumes/bootfs  # Write startup.conf to boot partition
# Boot Pi — it auto-joins Tailscale and is reachable as otacon-pi
make push                              # Deploy everything
```

#### How `startup.conf` is generated

`make pigen-config` reads environment variables (typically loaded from `.env`
via direnv) and writes them to `$DEVICE/otacon/startup.conf` on the SD card's
boot partition. On first boot, the Pi consumes this file (then securely
deletes it) to bootstrap Tailscale, the kiosk hostname, etc.

Variables read by `pigen-config` (and where they end up):

| Variable in `.env` | Required | Written to `startup.conf` if set |
|---|---|---|
| `TS_AUTH_KEY` | yes (errors if missing) | always |
| `TS_HOSTNAME` | no (defaults to `otacon-pi`) | only if set |
| `VNC_PASSWORD` | no | only if set |
| `OTACON_REPO` | no | only if set |
| `WIFI_AP_SSID` | no | only if set |
| `WIFI_AP_PASSWORD` | no | only if set |

So the typical flow is: edit `.env`, then run `make pigen-config DEVICE=/Volumes/bootfs`.
See `pigen/otacon/startup.conf.example` for the full format and inline docs.

### Set up a phone

```bash
make phone-setup   # Lock down connected phone (requires factory-reset, no Google accounts)
make phone-reset   # Remove phone lockdown
```

## Accessing services

All services are accessible over your Tailscale network:

| Service | URL |
|---------|-----|
| Admin UI | `http://otacon-registry.<tailnet>.ts.net:9080/?token=<otc_admin_*>` |
| Per-Pi web UI | `https://otacon-pi.<tailnet>.ts.net:8080/` |
| VNC (phone screen) | `vnc://otacon-pi.<tailnet>.ts.net:5900` (port varies per phone — see `otacon info`) |
| Audio stream (VLC/ffplay) | `https://otacon-pi.<tailnet>.ts.net:8080/phones/<id>/audio` |
| Audio WebSocket | `wss://otacon-pi.<tailnet>.ts.net:8080/phones/<id>/ws/audio/call` |

Multiple phones on a single Pi each get their own VNC port (5900, 5901, ...) — `otacon info` returns the right `vnc_port` for the active phone.

The per-Pi web UI provides Listen (hear phone audio) and Mic (send your mic to the phone) controls. Mic requires HTTPS, which is why the Tailscale FQDN is used.

Find your tailnet name: `tailscale status --self --json | grep DNSName`

## CLI

The `otacon` CLI lets you drive any phone in the fleet from your laptop. Inside this repo, use `pnpm cli ...` to run the in-tree TypeScript source; in deployed environments the binary is just `otacon`.

```bash
# First-time setup on your machine
pnpm cli auth register --registry http://otacon-registry.<tailnet>.ts.net:9080
# (have an admin approve via `pnpm cli reg approve <id>` or the admin UI)

pnpm cli phone list            # see all phones in the fleet
pnpm cli phone use phone-2     # pick a default
pnpm cli info                  # screen state, model, activity, vnc_port, etc.
pnpm cli screenshot            # save current screen as PNG
pnpm cli tap e5                # tap an accessibility-tree element by ref
```

See `skills/otacon-cli/SKILL.md` for the full command reference (organized for AI-agent consumption — works for humans too).

## Configuration

All config lives in `.env` (gitignored, loaded by direnv). See `.env.example` for all available variables.

Key variables:
- `PI_HOST` — Pi hostname (default: `otacon-pi`)
- `VNC_PASSWORD` — VNC authentication password
- `TS_AUTH_KEY` — Tailscale pre-auth key (for first boot)
- `OTACON_REPO` — Docker image repo (`otacon-dev` for dev, `otacon` for prod)
- `ALSA_CAPTURE_DEVICE` / `ALSA_PLAYBACK_DEVICE` — ALSA device names (default: `plughw:Device,0`)

## Registry Deployment

The registry runs as a separate Docker stack with its own lifecycle, independent of the host containers. It joins the tailnet under its own Tailscale identity (default `otacon-registry`) so it gets its own FQDN — no port-collision concerns even when sharing the same Pi as the host stack.

```bash
make registry-build                        # Build registry image locally
make registry-deploy                       # Deploy to default REGISTRY_HOST (=PI_HOST)
make registry-deploy REGISTRY_HOST=my-vps  # Deploy to any SSH-accessible host
make registry-logs                         # Tail registry logs
make registry-restart                      # Restart registry container
```

The registry serves on port 9080 over the tailnet sidecar — only reachable as `http://otacon-registry.<tailnet>.ts.net:9080`, never on the host machine's own ports. Set `TS_AUTH_KEY_REGISTRY` in `.env` for the sidecar's tailnet auth.

The registry mirrors host state via the host → registry event delivery layer documented in `AGENTS.md`. Data persists in a Docker named volume (`registry-data`). No manual migration is needed — hosts send a `host.snapshot` event on startup that brings the registry into agreement.

A bootstrap admin token is printed to stderr on first run. Save it — you'll need it to access the admin UI and approve the first CLI/host registrations. If you lose it, see the gotcha in `AGENTS.md`.

## Make Targets

Default `PI_HOST` is `otacon-pi` (override via `.env` or `PI_HOST=...`).

```
Deploy:
  make push             Provision Pi, build + push images, pull on Pi, start
  make provision        Run Ansible provisioning only
  make deploy-docker    Build + push + pull Docker images only

Setup:
  make setup-pi         Log Pi into ghcr.io (one-time)

Services (on Pi via SSH):
  make up               Start containers
  make down             Stop containers
  make logs             Tail container logs
  make health           Check all services are running

Build (local):
  make build            Build Docker images locally
  make pigen            Build flashable Pi image
  make pigen-flash      Flash Pi image (DEVICE=/dev/sdX)
  make pigen-config     Write startup.conf to SD card boot partition (DEVICE=/Volumes/bootfs)

Phone:
  make phone-setup      Lock down connected phone
  make phone-reset      Remove phone lockdown

Registry:
  make registry-build   Build registry Docker image
  make registry-deploy  Deploy registry to host (REGISTRY_HOST=otacon-pi)
  make registry-logs    Tail registry logs
  make registry-restart Restart registry container
```
