#!/usr/bin/env bash
# Hardware test: Registry running on Pi responds correctly
#
# Verifies:
#   1. curl to Pi-hosted registry returns valid JSON with host entry
#   2. Registry container shows "Up" status in docker compose ps
#
# Usage: ./test_registry_on_pi_responds.sh
# Requires: curl, jq, ssh access to otacon-pi

set -euo pipefail

PI="nick@otacon-pi"
source "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/lib/tailscale.sh"

echo "=== Test: registry on Pi responds ==="

# --- Step 1: Check /api/v1/hosts returns valid JSON ---
echo ""
echo "--- Checking $REGISTRY_URL/api/v1/hosts ---"
HOSTS=$(curl -sf "$REGISTRY_URL/api/v1/hosts" 2>&1) || {
    echo "FAIL: could not reach registry at $REGISTRY_URL/api/v1/hosts"
    exit 1
}

# Validate it's a JSON array
if ! echo "$HOSTS" | jq -e 'type == "array"' >/dev/null 2>&1; then
    echo "FAIL: /api/v1/hosts did not return a JSON array"
    echo "Got: $HOSTS"
    exit 1
fi
echo "PASS: /api/v1/hosts returns valid JSON array"

# Check for otacon-pi host entry (host uses "id" field)
PI_HOST=$(echo "$HOSTS" | jq -r '[.[] | select(.id == "otacon-pi")] | length')
if [ "$PI_HOST" -lt 1 ]; then
    echo "FAIL: no host entry with id 'otacon-pi' found"
    echo "  Hosts returned: $(echo "$HOSTS" | jq -c '[.[].id]')"
    exit 1
fi
echo "PASS: otacon-pi host entry found"

# --- Step 2: Check container status ---
echo ""
echo "--- Checking registry container status ---"
CONTAINER_STATUS=$(ssh "$PI" "docker ps --filter name=registry --format '{{.Names}} {{.Status}}'" 2>/dev/null) || {
    echo "FAIL: could not check container status on Pi"
    exit 1
}

if [ -z "$CONTAINER_STATUS" ]; then
    echo "FAIL: no running registry container found"
    exit 1
fi

if ! echo "$CONTAINER_STATUS" | grep -q "Up"; then
    echo "FAIL: registry container is not running"
    echo "  Status: $CONTAINER_STATUS"
    exit 1
fi
echo "PASS: registry container running: $CONTAINER_STATUS"

echo ""
echo "=== Test: registry on Pi responds PASSED ==="
