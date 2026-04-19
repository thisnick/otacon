#!/usr/bin/env bash
# Hardware test: Registry data survives container restart
#
# Verifies:
#   1. Captures initial host + phone counts
#   2. Restarts registry container via docker compose down/up
#   3. Waits for restart + reconnect
#   4. Verifies counts unchanged (data survived via named volume)
#
# Usage: ./test_registry_data_persists.sh
# Requires: curl, jq, ssh access to otacon-pi

set -euo pipefail

PI="nick@otacon-pi"
source "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/lib/tailscale.sh"
COMPOSE_DIR="/home/nick/otacon-registry"
RESTART_WAIT=30

echo "=== Test: registry data persists across restart ==="

# --- Step 1: Capture initial counts ---
echo ""
echo "--- Capturing initial state ---"
HOSTS_BEFORE=$(curl -sf "$REGISTRY_URL/api/v1/hosts" || echo "[]")
PHONES_BEFORE=$(curl -sf "$REGISTRY_URL/api/v1/phones" || echo "[]")

HOST_COUNT_BEFORE=$(echo "$HOSTS_BEFORE" | jq 'length')
PHONE_COUNT_BEFORE=$(echo "$PHONES_BEFORE" | jq 'length')

echo "Hosts before: $HOST_COUNT_BEFORE"
echo "Phones before: $PHONE_COUNT_BEFORE"

if [ "$HOST_COUNT_BEFORE" -eq 0 ] && [ "$PHONE_COUNT_BEFORE" -eq 0 ]; then
    echo "WARN: registry has no data — test will verify counts stay at 0"
fi

# --- Step 2: Restart registry container ---
echo ""
echo "--- Restarting registry container ---"
ssh "$PI" "cd $COMPOSE_DIR && docker compose down" 2>/dev/null
echo "Container stopped."

ssh "$PI" "cd $COMPOSE_DIR && docker compose up -d" 2>/dev/null
echo "Container started."

# --- Step 3: Wait for restart ---
echo ""
echo "--- Waiting ${RESTART_WAIT}s for restart + reconnect ---"
sleep "$RESTART_WAIT"

# --- Step 4: Verify counts unchanged ---
echo ""
echo "--- Verifying data persisted ---"

# Retry a few times in case the registry is still starting up
RETRY=0
MAX_RETRY=5
while [ "$RETRY" -lt "$MAX_RETRY" ]; do
    HOSTS_AFTER=$(curl -sf "$REGISTRY_URL/api/v1/hosts" 2>/dev/null || echo "")
    if [ -n "$HOSTS_AFTER" ]; then
        break
    fi
    RETRY=$((RETRY + 1))
    echo "  Registry not ready yet, retrying in 5s ($RETRY/$MAX_RETRY)..."
    sleep 5
done

if [ -z "$HOSTS_AFTER" ]; then
    echo "FAIL: registry did not come back up after restart"
    exit 1
fi

PHONES_AFTER=$(curl -sf "$REGISTRY_URL/api/v1/phones" || echo "[]")

HOST_COUNT_AFTER=$(echo "$HOSTS_AFTER" | jq 'length')
PHONE_COUNT_AFTER=$(echo "$PHONES_AFTER" | jq 'length')

echo "Hosts after: $HOST_COUNT_AFTER (was: $HOST_COUNT_BEFORE)"
echo "Phones after: $PHONE_COUNT_AFTER (was: $PHONE_COUNT_BEFORE)"

if [ "$HOST_COUNT_AFTER" -lt "$HOST_COUNT_BEFORE" ]; then
    echo "FAIL: host count dropped from $HOST_COUNT_BEFORE to $HOST_COUNT_AFTER after restart"
    exit 1
fi
echo "PASS: host count preserved"

if [ "$PHONE_COUNT_AFTER" -lt "$PHONE_COUNT_BEFORE" ]; then
    echo "FAIL: phone count dropped from $PHONE_COUNT_BEFORE to $PHONE_COUNT_AFTER after restart"
    exit 1
fi
echo "PASS: phone count preserved"

echo ""
echo "=== Test: registry data persists PASSED ==="
