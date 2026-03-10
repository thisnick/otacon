# Otacon

Infrastructure-as-code for a Raspberry Pi phone kiosk — mirrors an Android phone's screen, provides reverse tethering, and locks down the device.

## Architecture

- **Ansible** — bootstrap only: installs Docker, system config, Tailscale
- **Docker** — all services: phone mirroring (Xvfb + scrcpy + x11vnc), reverse tethering (gnirehtet)
- **Android app** — Device Owner app that locks down WiFi, Bluetooth, GPS, factory reset, etc.
- **Pi-gen** — builds flashable Raspberry Pi images with everything pre-configured

## Quick Start

### On an existing Pi

```bash
# Bootstrap (installs Docker, system config)
bash scripts/bootstrap.sh

# Start services
docker compose up -d

# Set up phone (requires factory-reset phone with no Google accounts)
make phone-setup
```

### From scratch (flash an image)

```bash
make pigen                        # Build image
make pigen-flash DEVICE=/dev/sdX  # Flash to SD card
# Boot Pi, connect phone, run phone-setup
```

## Development

### Deploy from Mac to Pi

```bash
make sync PI=tiny-pi        # Ansible changes only
make deploy-ssh PI=tiny-pi  # Docker image changes
make push PI=tiny-pi        # Everything
```

### Build artifacts

| Artifact | Local | CI |
|----------|-------|----|
| Docker images | `make build` | Push to main → ghcr.io |
| Android APK | `cd android/device-owner && ./gradlew assembleRelease` | Push to main or release |
| Pi image | `make pigen` | Manual trigger or release |

## Make Targets

```
make build            Build Docker images locally
make up               Start all services
make down             Stop all services
make logs             Tail service logs
make deploy-ssh       Build + deploy Docker images to Pi via SSH
make sync             Sync Ansible to Pi + run provision
make push             Sync everything to Pi
make provision        Run Ansible bootstrap (on Pi)
make provision-check  Ansible dry-run
make phone-setup      Lock down connected phone
make phone-reset      Remove phone lockdown
make health           Check all services
make pigen            Build Pi image
make pigen-flash      Flash Pi image to SD card
```
