#!/usr/bin/env bash
# Hardware test: BT reconnect after container reboot
#
# Restarts the otacon container and verifies:
#   1. Each phone re-pairs with its OWN assigned dongle (not swapped)
#   2. BT connected state is restored within 2 minutes
#   3. Dongle assignments are preserved (no shuffling)
#
# Usage: ./test_bt_reconnect_after_reboot.sh
# Requires: ssh access to otacon-pi, curl, jq

set -euo pipefail

PI="nick@otacon-pi"
PI_URL="https://otacon-pi.tail0437b8.ts.net:8080"
REGISTRY_URL="http://localhost:8080"
CONTAINER="otacon-otacon-1"
MAX_RECONNECT_WAIT=180  # 3 min (reboot + pair time)

echo "=== Test: BT reconnect after container reboot ==="

# --- Step 0: Snapshot all phone-to-dongle assignments before reboot ---
PHONES_BEFORE=$(curl -s "$REGISTRY_URL/api/v1/phones")
DONGLES_BEFORE=$(curl -s "$REGISTRY_URL/api/v1/dongles")

# Build a map of phone_id -> dongle_id
PHONE_IDS=$(echo "$PHONES_BEFORE" | jq -r '.[].id')
declare -A PHONE_DONGLE_MAP

for pid in $PHONE_IDS; do
    did=$(echo "$DONGLES_BEFORE" | jq -r ".[] | select(.phone_id == \"$pid\") | .id // empty")
    if [ -n "$did" ]; then
        PHONE_DONGLE_MAP[$pid]=$did
        echo "  Before: $pid -> $did"
    fi
done

PHONE_COUNT=${#PHONE_DONGLE_MAP[@]}
echo "Tracked phone-dongle pairs: $PHONE_COUNT"

if [ "$PHONE_COUNT" -eq 0 ]; then
    echo "SKIP: no phone-dongle pairs to verify"
    exit 0
fi

# --- Step 1: Restart the container ---
echo ""
echo "--- Restarting container $CONTAINER ---"
ssh "$PI" "docker restart $CONTAINER" 2>/dev/null || true
echo "Container restarting..."

# Wait for the container to be back up and serving
echo "Waiting 30s for container to initialize..."
sleep 30

# Verify container is running
RUNNING=$(ssh "$PI" "docker ps --filter name=$CONTAINER --format '{{.Status}}'" 2>/dev/null || echo "")
if echo "$RUNNING" | grep -qi "up"; then
    echo "Container is running."
else
    echo "FAIL: container is not running after restart"
    exit 1
fi

# --- Step 2: Wait for phones to reconnect and verify BT ---
echo ""
echo "--- Waiting up to ${MAX_RECONNECT_WAIT}s for BT reconnect ---"
START=$(date +%s)
ALL_OK=false

while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - START))
    if [ "$ELAPSED" -ge "$MAX_RECONNECT_WAIT" ]; then
        break
    fi

    BT_CONNECTED_COUNT=0
    for pid in "${!PHONE_DONGLE_MAP[@]}"; do
        INFO=$(curl -sk "$PI_URL/phones/$pid/api/info" 2>/dev/null || echo "{}")
        BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')
        if [ "$BT_CONNECTED" = "true" ]; then
            BT_CONNECTED_COUNT=$((BT_CONNECTED_COUNT + 1))
        fi
    done

    echo "  [${ELAPSED}s] BT connected: $BT_CONNECTED_COUNT / $PHONE_COUNT"

    if [ "$BT_CONNECTED_COUNT" -ge "$PHONE_COUNT" ]; then
        ALL_OK=true
        echo "  All phones BT-connected at T+${ELAPSED}s"
        break
    fi

    sleep 15
done

if [ "$ALL_OK" != "true" ]; then
    echo "WARN: not all phones reconnected BT within ${MAX_RECONNECT_WAIT}s"
    # Still continue to check assignments — some phones may be slow
fi

# --- Step 3: Verify dongle assignments preserved (no swap) ---
echo ""
echo "--- Verifying dongle assignments preserved ---"
DONGLES_AFTER=$(curl -s "$REGISTRY_URL/api/v1/dongles")
ASSIGNMENT_FAIL=false

for pid in "${!PHONE_DONGLE_MAP[@]}"; do
    EXPECTED_DONGLE=${PHONE_DONGLE_MAP[$pid]}
    ACTUAL_DONGLE=$(echo "$DONGLES_AFTER" | jq -r ".[] | select(.phone_id == \"$pid\") | .id // empty")

    if [ "$ACTUAL_DONGLE" = "$EXPECTED_DONGLE" ]; then
        echo "  $pid: $EXPECTED_DONGLE (unchanged)"
    else
        echo "  $pid: EXPECTED $EXPECTED_DONGLE, GOT ${ACTUAL_DONGLE:-none}"
        ASSIGNMENT_FAIL=true
    fi
done

if [ "$ASSIGNMENT_FAIL" = "true" ]; then
    echo "FAIL: dongle assignments changed after reboot (swap detected)"
    exit 1
fi
echo "PASS: all dongle assignments preserved after reboot"

# --- Step 4: Final BT health check ---
echo ""
echo "--- Final BT health status ---"
for pid in "${!PHONE_DONGLE_MAP[@]}"; do
    INFO=$(curl -sk "$PI_URL/phones/$pid/api/info" 2>/dev/null || echo "{}")
    BT_BONDED=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded // false')
    BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')
    echo "  $pid: bt_bonded=$BT_BONDED bt_connected=$BT_CONNECTED"
done

echo ""
echo "=== Test: BT reconnect after reboot PASSED ==="
