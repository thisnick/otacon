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

# Write .env — pull TS auth key from local .env (only registry needs one)
TS_AUTH_KEY_REGISTRY="${TS_AUTH_KEY_REGISTRY:-}"
OTACON_ADMIN_USERS="${OTACON_ADMIN_USERS:-}"
REGISTRY_BOOTSTRAP_ADMIN_TOKEN="${REGISTRY_BOOTSTRAP_ADMIN_TOKEN:-}"

if [ -z "${TS_AUTH_KEY_REGISTRY}" ]; then
    if [ -f .env ]; then
        eval "$(grep -E '^TS_AUTH_KEY_REGISTRY=' .env 2>/dev/null || true)"
    fi
fi

if [ -z "${REGISTRY_BOOTSTRAP_ADMIN_TOKEN}" ]; then
    if [ -f .env ]; then
        eval "$(grep -E '^REGISTRY_BOOTSTRAP_ADMIN_TOKEN=' .env 2>/dev/null || true)"
    fi
fi

if [ -z "${TS_AUTH_KEY_REGISTRY}" ]; then
    echo "WARNING: TS_AUTH_KEY_REGISTRY not set. Registry Tailscale sidecar will not start."
fi

ssh "${REMOTE}" "cat > ${REMOTE_DIR}/.env" <<EOF
TS_AUTH_KEY_REGISTRY=${TS_AUTH_KEY_REGISTRY}
OTACON_REPO=${OTACON_REPO:-otacon-dev}
OTACON_ADMIN_USERS=${OTACON_ADMIN_USERS}
REGISTRY_BOOTSTRAP_ADMIN_TOKEN=${REGISTRY_BOOTSTRAP_ADMIN_TOKEN}
EOF

# Pull and start
echo "Pulling images and starting services on ${PI_HOST}..."
ssh "${REMOTE}" "cd ${REMOTE_DIR} && docker compose pull && docker compose up -d"

echo "=== Registry + admin deployed ==="
echo "  Registry: http://otacon-registry.tail*.ts.net:9080  (own Tailscale identity)"
echo "  Admin:    http://${PI_HOST}:9090                    (host port, no Tailscale sidecar)"
echo ""
echo "Check admin bootstrap token: ssh ${REMOTE} 'cd ${REMOTE_DIR} && docker compose logs otacon-admin | grep BOOTSTRAP'"
