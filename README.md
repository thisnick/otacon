# Otacon

Infrastructure-as-code for a Raspberry Pi phone kiosk — mirrors an Android phone's screen, provides reverse tethering, streams bidirectional audio, and locks down the device.

## Architecture

- **Ansible** — bootstrap: installs Docker, system config, Tailscale, TLS certs
- **Docker** — single `otacon` container: phone mirroring (Xvfb + scrcpy + TigerVNC), reverse tethering (gnirehtet), audio streaming (otacon-server). Watchtower for auto-updates.
- **Android app** — Device Owner app that locks down WiFi, Bluetooth, GPS, factory reset, etc.
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
make pigen-config DEVICE=/Volumes/bootfs  # Write Tailscale auth to boot partition
# Boot Pi — it auto-joins Tailscale and is reachable as otacon-pi
make push                              # Deploy everything
```

### Set up a phone

```bash
make phone-setup   # Lock down connected phone (requires factory-reset, no Google accounts)
make phone-reset   # Remove phone lockdown
```

## Accessing services

All services are accessible over your Tailscale network:

| Service | URL |
|---------|-----|
| VNC (phone screen) | `vnc://otacon-pi:5900` |
| Audio monitor (browser) | `https://otacon-pi.<tailnet>.ts.net:8080/` |
| Audio stream (VLC/ffplay) | `https://otacon-pi.<tailnet>.ts.net:8080/audio` |
| Audio WebSocket | `wss://otacon-pi.<tailnet>.ts.net:8080/ws` |

The audio monitor page provides Listen (hear phone audio) and Mic (send your mic to the phone) controls. Mic requires HTTPS, which is why the Tailscale FQDN is used.

Find your tailnet name: `tailscale status --self --json | grep DNSName`

## Configuration

All config lives in `.env` (gitignored, loaded by direnv). See `.env.example` for all available variables.

Key variables:
- `PI_HOST` — Pi hostname (default: `otacon-pi`)
- `VNC_PASSWORD` — VNC authentication password
- `TS_AUTH_KEY` — Tailscale pre-auth key (for first boot)
- `OTACON_REPO` — Docker image repo (`otacon-dev` for dev, `otacon` for prod)
- `ALSA_CAPTURE_DEVICE` / `ALSA_PLAYBACK_DEVICE` — ALSA device names (default: `plughw:Device,0`)

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
```
