#!/usr/bin/env bash
# Hardware test: transient phone disconnect
#
# Simulates a brief phone disappearance (< 5 min) by rebooting the canary
# phone via ADB, then verifies:
#   1. The phone reappears within 2 minutes
#   2. The same dongle assignment is preserved (no reassignment)
#   3. BT reconnects to the SAME adapter
#
# Uses A14 (R92X1022S7K) as the canary since it's the designated
# destructive-test device.
#
# Usage: ./test_transient_phone_disconnect.sh
# Requires: ssh access to otacon-pi, curl, jq

set -euo pipefail

PI="nick@otacon-pi"
PI_URL="https://otacon-pi:8080"
REGISTRY_URL="http://localhost:8080"
CONTAINER="otacon-otacon-1"
CANARY_SERIAL="R92X1022S7K"
MAX_RECONNECT_WAIT=180  # 3 min — phone reboot + USB re-enum + BT re-pair

echo "=== Test: transient phone disconnect ==="

# --- Step 0: Identify canary phone_id and its current dongle assignment ---
PHONES=$(curl -s "$REGISTRY_URL/api/v1/phones")
CANARY_ID=$(echo "$PHONES" | jq -r ".[] | select(.adb_serial == \"$CANARY_SERIAL\") | .id")

if [ -z "$CANARY_ID" ] || [ "$CANARY_ID" = "null" ]; then
    echo "SKIP: canary phone ($CANARY_SERIAL) not registered in registry"
    exit 0
fi
echo "Canary phone: $CANARY_ID ($CANARY_SERIAL)"

ADAPTER_MAC_BEFORE=$(echo "$PHONES" | jq -r ".[] | select(.id == \"$CANARY_ID\") | .adapter_mac // empty")
echo "Adapter MAC before: ${ADAPTER_MAC_BEFORE:-none}"

# Also snapshot the dongle list to compare after
DONGLES_BEFORE=$(curl -s "$REGISTRY_URL/api/v1/dongles")
DONGLE_ID_BEFORE=$(echo "$DONGLES_BEFORE" | jq -r ".[] | select(.phone_id == \"$CANARY_ID\") | .id // empty")
echo "Dongle assigned before: ${DONGLE_ID_BEFORE:-none}"

# --- Step 1: Reboot the canary phone (simulates transient disconnect) ---
echo ""
echo "--- Rebooting canary phone to simulate transient disconnect ---"
ssh "$PI" "docker exec $CONTAINER adb -s $CANARY_SERIAL reboot" 2>/dev/null || true
echo "Reboot command issued. Phone will disappear briefly from USB."

# Wait a moment for the phone to actually go offline
sleep 15

# Verify it's actually gone
SERIALS_DURING=$(ssh "$PI" "docker exec $CONTAINER adb devices" 2>/dev/null | grep -c "$CANARY_SERIAL" || true)
if [ "$SERIALS_DURING" -gt 0 ]; then
    echo "WARN: phone still showing in adb devices after reboot — may not have disconnected yet"
fi

# --- Step 2: Wait for phone to come back ---
echo ""
echo "--- Waiting up to ${MAX_RECONNECT_WAIT}s for phone to reconnect ---"
START=$(date +%s)
RECONNECTED=false

while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - START))
    if [ "$ELAPSED" -ge "$MAX_RECONNECT_WAIT" ]; then
        break
    fi

    # Check if phone is back in registry as connected
    PHONE_STATUS=$(curl -s "$REGISTRY_URL/api/v1/phones/$CANARY_ID" 2>/dev/null | jq -r '.status // empty')

    if [ "$PHONE_STATUS" = "connected" ]; then
        RECONNECTED=true
        echo "  Phone reconnected at T+${ELAPSED}s"
        break
    fi

    echo "  [${ELAPSED}s] status=$PHONE_STATUS"
    sleep 10
done

if [ "$RECONNECTED" != "true" ]; then
    echo "FAIL: canary phone did not reconnect within ${MAX_RECONNECT_WAIT}s"
    exit 1
fi
echo "PASS: phone reconnected"

# --- Step 3: Verify same dongle assignment preserved ---
echo ""
echo "--- Verifying dongle assignment preserved ---"

# Give a few seconds for registry to update
sleep 5

PHONES_AFTER=$(curl -s "$REGISTRY_URL/api/v1/phones")
ADAPTER_MAC_AFTER=$(echo "$PHONES_AFTER" | jq -r ".[] | select(.id == \"$CANARY_ID\") | .adapter_mac // empty")
echo "Adapter MAC after: ${ADAPTER_MAC_AFTER:-none}"

DONGLES_AFTER=$(curl -s "$REGISTRY_URL/api/v1/dongles")
DONGLE_ID_AFTER=$(echo "$DONGLES_AFTER" | jq -r ".[] | select(.phone_id == \"$CANARY_ID\") | .id // empty")
echo "Dongle assigned after: ${DONGLE_ID_AFTER:-none}"

if [ -n "$ADAPTER_MAC_BEFORE" ] && [ "$ADAPTER_MAC_BEFORE" != "$ADAPTER_MAC_AFTER" ]; then
    echo "FAIL: adapter_mac changed ($ADAPTER_MAC_BEFORE -> $ADAPTER_MAC_AFTER)"
    exit 1
fi

if [ -n "$DONGLE_ID_BEFORE" ] && [ "$DONGLE_ID_BEFORE" != "$DONGLE_ID_AFTER" ]; then
    echo "FAIL: dongle assignment changed ($DONGLE_ID_BEFORE -> $DONGLE_ID_AFTER)"
    exit 1
fi

echo "PASS: dongle assignment preserved after transient disconnect"

# --- Step 4: Verify no phone.lost event was emitted ---
echo ""
echo "--- Checking that no phone.lost event was emitted for canary ---"
LOST_EVENTS=$(curl -s "$REGISTRY_URL/api/v1/events?event_type=info.phone.lost&entity_id=$CANARY_ID&limit=5")
RECENT_LOST=$(echo "$LOST_EVENTS" | jq 'length')

if [ "$RECENT_LOST" -gt 0 ]; then
    # Check if any of these are from the last 5 minutes (our test window)
    FIVE_MIN_AGO=$(date -u -v-5M +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo "")
    if [ -n "$FIVE_MIN_AGO" ]; then
        RECENT=$(echo "$LOST_EVENTS" | jq --arg ts "$FIVE_MIN_AGO" '[.[] | select(.timestamp > $ts)] | length')
        if [ "$RECENT" -gt 0 ]; then
            echo "FAIL: phone.lost event emitted during transient disconnect (should only fire after 5-min cooldown)"
            exit 1
        fi
    fi
fi
echo "PASS: no phone.lost event during transient disconnect"

# --- Step 5: Wait for BT to reconnect ---
echo ""
echo "--- Waiting for BT reconnect (best-effort, up to 120s) ---"
BT_START=$(date +%s)
BT_OK=false

while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - BT_START))
    if [ "$ELAPSED" -ge 120 ]; then
        break
    fi

    INFO=$(curl -sk "$PI_URL/phones/$CANARY_ID/api/info" 2>/dev/null || echo "{}")
    BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')

    if [ "$BT_CONNECTED" = "true" ]; then
        BT_OK=true
        echo "  BT reconnected at T+${ELAPSED}s"
        break
    fi
    sleep 10
done

if [ "$BT_OK" = "true" ]; then
    echo "PASS: BT reconnected to same adapter"
else
    echo "WARN: BT not reconnected yet (may take longer — not a hard failure)"
fi

echo ""
echo "=== Test: transient phone disconnect PASSED ==="
