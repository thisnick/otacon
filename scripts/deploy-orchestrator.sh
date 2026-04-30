#!/bin/bash
# Deploy the orchestrator container stack to the VPS provisioned by
# `tofu apply` (hostname `otacon-orchestrator` on the tailnet).
#
# Mirrors `scripts/deploy-registry.sh`: build + push the Docker image,
# rsync the compose file, write a fresh `/opt/orchestrator/.env` with
# secrets pulled from the local `.env`, then `docker compose pull && up -d`
# on the remote.
#
# Idempotent. Safe to re-run after image bumps. Watchtower on the VPS
# also auto-rolls images, so this script is mainly for env-var changes
# + the first deploy.
#
# Usage: scripts/deploy-orchestrator.sh [host]
#        host defaults to otacon-orchestrator.tail0437b8.ts.net
set -euo pipefail

ORCH_HOST="${1:-${ORCH_HOST:-otacon-orchestrator.tail0437b8.ts.net}}"
SSH_USER="${ORCH_SSH_USER:-ubuntu}"
REMOTE="${SSH_USER}@${ORCH_HOST}"
REMOTE_DIR="/opt/orchestrator"

echo "=== Deploying orchestrator to ${REMOTE} ==="

# SSH multiplexing — one connection, one YubiKey touch (matches the
# registry deploy script's pattern).
SSH_SOCK="/tmp/otacon-orchestrator-deploy-${ORCH_HOST}"
echo "Establishing SSH connection (touch YubiKey if needed)..."
ssh -NM -S "${SSH_SOCK}" "${REMOTE}" &
SSH_MUX_PID=$!
while ! command ssh -S "${SSH_SOCK}" -O check "${REMOTE}" 2>/dev/null; do sleep 0.1; done
export RSYNC_RSH="ssh -S ${SSH_SOCK}"
ssh() { command ssh -S "${SSH_SOCK}" "$@"; }
trap 'command ssh -S "${SSH_SOCK}" -O exit "${REMOTE}" 2>/dev/null || true' EXIT

# Pull required env vars from local .env if not already in the
# environment. Caller can override any of these by exporting first.
load_from_env() {
    local key="$1"
    local current="${!key:-}"
    if [ -z "${current}" ] && [ -f .env ]; then
        eval "$(grep -E "^${key}=" .env 2>/dev/null || true)"
    fi
}
load_from_env REGISTRY_BOOTSTRAP_ADMIN_TOKEN
load_from_env AI_GATEWAY_API_KEY
load_from_env OTACON_REPO

# OTACON_TOKEN for the orchestrator IS the registry's admin bootstrap
# token (same value the local CLI uses to call the registry). Per
# lead's brief.
OTACON_TOKEN="${OTACON_TOKEN:-${REGISTRY_BOOTSTRAP_ADMIN_TOKEN:-}}"

# Tailscale: the host's `tailscale up` (set up by cloud-init on first
# boot) handles both admin SSH AND HTTPS Serve for the orchestrator
# container. No sidecar, so the deploy script doesn't write a
# TS_AUTH_KEY anywhere — that key was only needed at first-boot time.

if [ -z "${OTACON_TOKEN}" ]; then
    echo "WARNING: OTACON_TOKEN (or REGISTRY_BOOTSTRAP_ADMIN_TOKEN) not set."
    echo "         Orchestrator → registry calls will 401."
fi
if [ -z "${AI_GATEWAY_API_KEY}" ]; then
    echo "WARNING: AI_GATEWAY_API_KEY not set. Model calls will fail."
fi

# Build + push the orchestrator image.
echo "Building and pushing orchestrator image..."
docker compose -f docker-compose.orchestrator.yml build otacon-orchestrator
docker compose -f docker-compose.orchestrator.yml push otacon-orchestrator

# Sync compose file. The remote name is plain `docker-compose.yml` so
# `docker compose ...` Just Works without a -f flag.
echo "Syncing compose file to ${REMOTE}:${REMOTE_DIR}/..."
ssh "${REMOTE}" "sudo mkdir -p ${REMOTE_DIR} && sudo chown ${SSH_USER}:${SSH_USER} ${REMOTE_DIR}"
rsync -az docker-compose.orchestrator.yml "${REMOTE}:${REMOTE_DIR}/docker-compose.yml"

# Write .env on the remote. Cloud-init pre-populates this on first
# boot but each deploy refreshes it so secret rotations land cleanly.
ssh "${REMOTE}" "cat > ${REMOTE_DIR}/.env" <<EOF
OTACON_REPO=${OTACON_REPO:-otacon-dev}
OTACON_REGISTRY_URL=${OTACON_REGISTRY_URL:-https://otacon-registry.tail0437b8.ts.net:9080}
OTACON_TOKEN=${OTACON_TOKEN}
AI_GATEWAY_API_KEY=${AI_GATEWAY_API_KEY}
ORCHESTRATOR_AUTH_REQUIRED=0
ORCHESTRATOR_DATA_DIR=/data/orchestrator
PORT=9090
ORCHESTRATOR_PORT=9090
EOF

# Pull + restart. `docker compose up -d` is a no-op when nothing
# changed; safe to run on every deploy.
echo "Pulling images and (re)starting services..."
ssh "${REMOTE}" "cd ${REMOTE_DIR} && docker compose pull && docker compose up -d"

echo
echo "=== Orchestrator deployed ==="
echo "  HTTP:  https://${ORCH_HOST}:9090/"
echo "  Logs:  ssh ${REMOTE} 'cd ${REMOTE_DIR} && docker compose logs -f --tail=50 otacon-orchestrator'"
echo
