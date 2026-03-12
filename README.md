# Otacon

Infrastructure-as-code for a Raspberry Pi phone kiosk — mirrors an Android phone's screen, provides reverse tethering, and locks down the device.

## Architecture

- **Ansible** — bootstrap only: installs Docker, system config, Tailscale
- **Docker** — all services: phone mirroring (Xvfb + scrcpy + x11vnc), reverse tethering (gnirehtet)
- **Android app** — Device Owner app that locks down WiFi, Bluetooth, GPS, factory reset, etc.
- **Pi-gen** — builds flashable Raspberry Pi images with everything pre-configured

## One-time setup

```bash
# Mac: log in to push dev images
docker login ghcr.io    # GitHub PAT with write:packages scope

# Pi: log in to pull dev images
make setup-pi PI=tiny-pi  # GitHub PAT with read:packages scope
```

Dev images push to `ghcr.io/thisnick/otacon-dev/*` (private). CI pushes to `ghcr.io/thisnick/otacon/*` (public).

## Quick Start

All commands run from your Mac. Nothing needs to be run on the Pi directly.

### Deploy to an existing Pi

```bash
make push PI=tiny-pi    # Provision + build + push + pull + start
make health PI=tiny-pi  # Verify everything is running
```

### From scratch (flash an image)

```bash
make pigen                        # Build image
make pigen-flash DEVICE=/dev/sdX  # Flash to SD card
# Boot Pi, then: make push PI=<hostname>
```

### Set up a phone

```bash
make phone-setup   # Lock down connected phone (requires factory-reset, no Google accounts)
make phone-reset   # Remove phone lockdown
```

## Make Targets

All targets accept `PI=<hostname>` (default: `tiny-pi`).

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

Phone:
  make phone-setup      Lock down connected phone
  make phone-reset      Remove phone lockdown
```
