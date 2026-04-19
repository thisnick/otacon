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
REGISTRY_URL="http://otacon-pi.tail0437b8.ts.net:9080"

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

# Check for otacon-pi host entry
PI_HOST=$(echo "$HOSTS" | jq -r '[.[] | select(.hostname == "otacon-pi" or .name == "otacon-pi")] | length')
if [ "$PI_HOST" -lt 1 ]; then
    echo "WARN: no host entry with hostname 'otacon-pi' found yet (may appear after first heartbeat)"
    echo "  Hosts returned: $(echo "$HOSTS" | jq -c '[.[].hostname // .[].name]')"
else
    echo "PASS: otacon-pi host entry found"
fi

# --- Step 2: Check container status ---
echo ""
echo "--- Checking registry container status ---"
COMPOSE_PS=$(ssh "$PI" "docker compose -f /home/nick/otacon-registry/docker-compose.registry.yml ps --format json" 2>/dev/null) || {
    echo "FAIL: could not run docker compose ps on Pi"
    exit 1
}

# Look for registry container with "running" state
RUNNING=$(echo "$COMPOSE_PS" | jq -r 'select(.State == "running") | .Name' 2>/dev/null || true)
if [ -z "$RUNNING" ]; then
    echo "FAIL: no running registry container found"
    echo "  docker compose ps output: $COMPOSE_PS"
    exit 1
fi
echo "PASS: registry container running: $RUNNING"

echo ""
echo "=== Test: registry on Pi responds PASSED ==="
