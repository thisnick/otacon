#!/bin/bash
# Deploy registry + admin containers to any SSH-able host.
# Usage: scripts/deploy-registry.sh <host>
set -euo pipefail

PI_HOST="${1:?Usage: $0 <host>}"
PI_USER="${PI_USER:-nick}"
REMOTE="${PI_USER}@${PI_HOST}"
REMOTE_DIR="~/otacon-registry"

echo "=== Deploying registry + admin to ${REMOTE} ==="

# SSH multiplexing: one connection, one YubiKey touch
SSH_SOCK="/tmp/otacon-registry-deploy-${PI_HOST}"
echo "Establishing SSH connection (touch YubiKey if needed)..."
ssh -NM -S "${SSH_SOCK}" "${REMOTE}" &
SSH_MUX_PID=$!
while ! command ssh -S "${SSH_SOCK}" -O check "${REMOTE}" 2>/dev/null; do sleep 0.1; done
export RSYNC_RSH="ssh -S ${SSH_SOCK}"
ssh() { command ssh -S "${SSH_SOCK}" "$@"; }
trap 'command ssh -S "${SSH_SOCK}" -O exit "${REMOTE}" 2>/dev/null' EXIT

# Build and push image (same binary, used by both services)
echo "Building and pushing registry image..."
docker compose -f docker-compose.registry.yml build otacon-registry
docker compose -f docker-compose.registry.yml push otacon-registry

# Sync compose file and env
echo "Syncing compose file to ${REMOTE}:${REMOTE_DIR}..."
ssh "${REMOTE}" "mkdir -p ${REMOTE_DIR}"
rsync -az docker-compose.registry.yml "${REMOTE}:${REMOTE_DIR}/docker-compose.yml"

# Write .env — pull TS auth keys from local .env
TS_AUTH_KEY_REGISTRY="${TS_AUTH_KEY_REGISTRY:-}"
TS_AUTH_KEY_ADMIN="${TS_AUTH_KEY_ADMIN:-}"
OTACON_ADMIN_USERS="${OTACON_ADMIN_USERS:-}"

if [ -z "${TS_AUTH_KEY_REGISTRY}" ] || [ -z "${TS_AUTH_KEY_ADMIN}" ]; then
    # Try reading from local .env
    if [ -f .env ]; then
        eval "$(grep -E '^TS_AUTH_KEY_(REGISTRY|ADMIN)=' .env 2>/dev/null || true)"
    fi
fi

if [ -z "${TS_AUTH_KEY_REGISTRY}" ]; then
    echo "WARNING: TS_AUTH_KEY_REGISTRY not set. Registry Tailscale sidecar will not start."
fi
if [ -z "${TS_AUTH_KEY_ADMIN}" ]; then
    echo "WARNING: TS_AUTH_KEY_ADMIN not set. Admin Tailscale sidecar will not start."
fi

ssh "${REMOTE}" "cat > ${REMOTE_DIR}/.env" <<EOF
TS_AUTH_KEY_REGISTRY=${TS_AUTH_KEY_REGISTRY}
TS_AUTH_KEY_ADMIN=${TS_AUTH_KEY_ADMIN}
OTACON_REPO=${OTACON_REPO:-otacon-dev}
OTACON_ADMIN_USERS=${OTACON_ADMIN_USERS}
EOF

# Pull and start
echo "Pulling images and starting services on ${PI_HOST}..."
ssh "${REMOTE}" "cd ${REMOTE_DIR} && docker compose pull && docker compose up -d"

echo "=== Registry + admin deployed ==="
echo "  Registry: http://otacon-registry.tail*.ts.net:9080"
echo "  Admin:    http://otacon-admin.tail*.ts.net:9090"
echo ""
echo "Check admin bootstrap token: ssh ${REMOTE} 'cd ${REMOTE_DIR} && docker compose logs otacon-admin | grep BOOTSTRAP'"
