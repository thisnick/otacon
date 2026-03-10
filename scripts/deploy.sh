#!/bin/bash
# Deploy from dev machine (Mac/Linux) to Pi via SSH.
# Usage: ./scripts/deploy.sh [pi-host]
set -euo pipefail

PI_HOST="${1:-${PI_HOST:-tiny-pi}}"
PI_USER="${PI_USER:-nick}"
REMOTE="${PI_USER}@${PI_HOST}"
REMOTE_DIR="~/code/otacon"

echo "=== Deploying to ${REMOTE} ==="

MODE="${2:-full}"

case "${MODE}" in
    ansible)
        echo "Syncing Ansible only..."
        rsync -az --delete \
            --exclude '.git' \
            ./ansible/ "${REMOTE}:${REMOTE_DIR}/ansible/"
        ssh "${REMOTE}" "cd ${REMOTE_DIR} && make provision"
        ;;
    docker)
        echo "Building and deploying Docker images..."
        docker compose build
        for service in $(docker compose config --services); do
            image=$(docker compose config --format json | jq -r ".services.\"${service}\".image")
            echo "Pushing ${image}..."
            docker save "${image}" | ssh "${REMOTE}" docker load
        done
        ssh "${REMOTE}" "cd ${REMOTE_DIR} && docker compose up -d"
        ;;
    full)
        echo "Syncing full repo..."
        rsync -az --delete \
            --exclude '.git' \
            --exclude 'target' \
            --exclude '.gradle' \
            --exclude 'build' \
            ./ "${REMOTE}:${REMOTE_DIR}/"
        ssh "${REMOTE}" "cd ${REMOTE_DIR} && make provision && docker compose up -d"
        ;;
    *)
        echo "Usage: $0 [pi-host] [ansible|docker|full]"
        exit 1
        ;;
esac

echo "=== Deploy complete ==="
