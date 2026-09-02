#!/bin/bash
# Deploy from dev machine (Mac/Linux) to Pi via SSH.
# Usage: ./scripts/deploy.sh [pi-host] [ansible|docker|pull|full]
set -euo pipefail

PI_HOST="${1:-${PI_HOST:-otacon-pi}}"
PI_USER="${PI_USER:-nick}"
REMOTE="${PI_USER}@${PI_HOST}"
REMOTE_DIR="~/otacon"

echo "=== Deploying to ${REMOTE} ==="

# SSH multiplexing: one connection, one YubiKey touch
SSH_SOCK="/tmp/otacon-deploy-${PI_HOST}"
echo "Establishing SSH connection (touch YubiKey)..."
ssh -NM -S "${SSH_SOCK}" "${REMOTE}" &
SSH_MUX_PID=$!
while ! command ssh -S "${SSH_SOCK}" -O check "${REMOTE}" 2>/dev/null; do sleep 0.1; done
export RSYNC_RSH="ssh -S ${SSH_SOCK}"
export ANSIBLE_SSH_ARGS="-o ControlPath=${SSH_SOCK}"
ssh() { command ssh -S "${SSH_SOCK}" "$@"; }
trap 'command ssh -S "${SSH_SOCK}" -O exit "${REMOTE}" 2>/dev/null' EXIT

MODE="${2:-full}"

provision() {
    echo "Provisioning..."
    cd ansible && ansible-playbook site.yml -e "pi_host=${PI_HOST}"
    cd ..
}

deploy_compose() {
    echo "Syncing docker-compose.yml, .env, and scripts..."
    ssh "${REMOTE}" "mkdir -p ${REMOTE_DIR}/scripts"
    rsync -az docker-compose.yml "${REMOTE}:${REMOTE_DIR}/docker-compose.yml"
    rsync -az scripts/ "${REMOTE}:${REMOTE_DIR}/scripts/"
    # Explicit allowlist: never copy builder, OCI, or registry-admin secrets.
    awk -F= '$1 ~ /^(OTACON_REPO|DISPLAY_NUM|DISPLAY_RESOLUTION|SCRCPY_MAX_FPS|SCRCPY_BITRATE|SCRCPY_MAX_SIZE|VNC_PORT|VNC_PASSWORD|WIFI_AP_SSID|WIFI_AP_PASSWORD|AUDIO_PORT|ALSA_CAPTURE_DEVICE|ALSA_PLAYBACK_DEVICE|AUDIO_BACKEND|REGISTRY_URL|TS_HOSTNAME|WATCHTOWER_POLL_INTERVAL)$/' \
        .env > /tmp/otacon-pi-env
    rsync -az /tmp/otacon-pi-env "${REMOTE}:${REMOTE_DIR}/.env"
    rm -f /tmp/otacon-pi-env
}

transfer_images() {
    echo "Building and pushing Docker images..."
    docker compose build
    docker compose push
}

pull_images() {
    echo "Pulling images on Pi..."
    ssh "${REMOTE}" "cd ${REMOTE_DIR} && docker compose pull && docker image prune -f"
}

start_images() {
    ssh "${REMOTE}" "cd ${REMOTE_DIR} && docker compose up -d"
}

case "${MODE}" in
    ansible)
        provision
        ;;
    docker)
        deploy_compose
        transfer_images
        pull_images
        start_images
        ;;
    pull)
        deploy_compose
        pull_images
        start_images
        ;;
    full)
        provision
        deploy_compose
        transfer_images
        pull_images
        start_images
        ;;
    *)
        echo "Usage: $0 [pi-host] [ansible|docker|pull|full]"
        exit 1
        ;;
esac

echo "=== Deploy complete ==="
