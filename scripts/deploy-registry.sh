#!/bin/bash
# Deploy registry container to any SSH-able host.
# Usage: scripts/deploy-registry.sh <host> [port]
set -euo pipefail

PI_HOST="${1:?Usage: $0 <host> [port]}"
PORT="${2:-9080}"
PI_USER="${PI_USER:-nick}"
REMOTE="${PI_USER}@${PI_HOST}"
REMOTE_DIR="~/otacon-registry"

echo "=== Deploying registry to ${REMOTE} (port ${PORT}) ==="

# SSH multiplexing: one connection, one YubiKey touch
SSH_SOCK="/tmp/otacon-registry-deploy-${PI_HOST}"
echo "Establishing SSH connection (touch YubiKey if needed)..."
ssh -NM -S "${SSH_SOCK}" "${REMOTE}" &
SSH_MUX_PID=$!
while ! command ssh -S "${SSH_SOCK}" -O check "${REMOTE}" 2>/dev/null; do sleep 0.1; done
export RSYNC_RSH="ssh -S ${SSH_SOCK}"
ssh() { command ssh -S "${SSH_SOCK}" "$@"; }
trap 'command ssh -S "${SSH_SOCK}" -O exit "${REMOTE}" 2>/dev/null' EXIT

# Build and push image
echo "Building and pushing registry image..."
docker compose -f docker-compose.registry.yml build
docker compose -f docker-compose.registry.yml push

# Sync compose file and env
echo "Syncing compose file to ${REMOTE}:${REMOTE_DIR}..."
ssh "${REMOTE}" "mkdir -p ${REMOTE_DIR}"
rsync -az docker-compose.registry.yml "${REMOTE}:${REMOTE_DIR}/docker-compose.yml"

# Write .env with the configured port
ssh "${REMOTE}" "cat > ${REMOTE_DIR}/.env" <<EOF
REGISTRY_HOST_PORT=${PORT}
OTACON_REPO=${OTACON_REPO:-otacon-dev}
EOF

# Pull and start
echo "Pulling image and starting registry on ${PI_HOST}..."
ssh "${REMOTE}" "cd ${REMOTE_DIR} && docker compose pull && docker compose up -d"

echo "=== Registry deployed at http://${PI_HOST}:${PORT} ==="
