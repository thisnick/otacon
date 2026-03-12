#!/bin/bash
# Deploy from dev machine (Mac/Linux) to Pi via SSH.
# Usage: ./scripts/deploy.sh [pi-host] [ansible|docker|full]
set -euo pipefail

PI_HOST="${1:-${PI_HOST:-tiny-pi}}"
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
    echo "Syncing docker-compose.yml..."
    ssh "${REMOTE}" "mkdir -p ${REMOTE_DIR}"
    rsync -az docker-compose.yml "${REMOTE}:${REMOTE_DIR}/docker-compose.yml"
    ssh "${REMOTE}" "echo 'OTACON_REPO=otacon-dev' > ${REMOTE_DIR}/.env"
}

transfer_images() {
    echo "Building and pushing Docker images..."
    OTACON_REPO=otacon-dev docker compose build
    OTACON_REPO=otacon-dev docker compose push
    echo "Pulling images on Pi..."
    ssh "${REMOTE}" "cd ${REMOTE_DIR} && docker compose pull"
}

case "${MODE}" in
    ansible)
        provision
        ;;
    docker)
        deploy_compose
        transfer_images
        ssh "${REMOTE}" "cd ${REMOTE_DIR} && docker compose up -d"
        ;;
    full)
        provision
        deploy_compose
        transfer_images
        ssh "${REMOTE}" "cd ${REMOTE_DIR} && docker compose up -d"
        ;;
    *)
        echo "Usage: $0 [pi-host] [ansible|docker|full]"
        exit 1
        ;;
esac

echo "=== Deploy complete ==="
