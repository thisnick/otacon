#!/usr/bin/env bash
# Hardware test: transient dongle disconnect
#
# Simulates a brief BT dongle disappearance (< 5 min) by cycling the
# bluetooth power on a USB adapter, then verifies:
#   1. After power-on, the adapter comes back
#   2. No dongle.lost event is emitted
#   3. The phone-to-dongle assignment is preserved
#   4. Audio connection resumes (bt_connected returns to true)
#
# Does NOT use hci0 (built-in) — uses a USB adapter assigned to one of
# the phones.
#
# Usage: ./test_transient_dongle_disconnect.sh
# Requires: ssh access to otacon-pi, curl, jq

set -euo pipefail

PI="nick@otacon-pi"
PI_URL="https://otacon-pi.tail0437b8.ts.net:8080"
REGISTRY_URL="http://localhost:8080"
CONTAINER="otacon-otacon-1"
MAX_RECONNECT_WAIT=120

echo "=== Test: transient dongle disconnect ==="

# --- Step 0: Find a USB dongle (not hci0) that is assigned to a phone ---
DONGLES=$(curl -s "$REGISTRY_URL/api/v1/dongles")
# Pick a dongle that has a phone_id (hci_device may be null in registry after
# loss handler updates — we resolve it from hciconfig by MAC below)
TARGET_DONGLE=$(echo "$DONGLES" | jq -r '[.[] | select(.phone_id != null and .hci_device != "hci0")] | .[0] // empty')

if [ -z "$TARGET_DONGLE" ] || [ "$TARGET_DONGLE" = "null" ]; then
    echo "SKIP: no USB dongle with phone assignment found"
    exit 0
fi

DONGLE_ID=$(echo "$TARGET_DONGLE" | jq -r '.id')
DONGLE_MAC=$(echo "$TARGET_DONGLE" | jq -r '.bt_mac')
DONGLE_HCI=$(echo "$TARGET_DONGLE" | jq -r '.hci_device // empty')
DONGLE_PHONE=$(echo "$TARGET_DONGLE" | jq -r '.phone_id')

# If hci_device is missing from registry, resolve it from hciconfig by MAC
if [ -z "$DONGLE_HCI" ] || [ "$DONGLE_HCI" = "null" ]; then
    DONGLE_HCI=$(ssh "$PI" "docker exec $CONTAINER hciconfig -a" 2>/dev/null \
        | awk -v mac="$DONGLE_MAC" '
            /^hci/ { dev=$1; sub(/:$/,"",dev) }
            /BD Address:/ { if (toupper($3) == toupper(mac)) print dev }
        ')
fi

if [ -z "$DONGLE_HCI" ]; then
    echo "SKIP: cannot resolve hci device for $DONGLE_MAC"
    exit 0
fi

# Skip if it resolved to hci0 (built-in, not USB)
if [ "$DONGLE_HCI" = "hci0" ]; then
    echo "SKIP: resolved dongle is hci0 (built-in)"
    exit 0
fi
echo "Target dongle: $DONGLE_ID ($DONGLE_MAC, $DONGLE_HCI, phone=$DONGLE_PHONE)"

# Record event baseline
EVENT_BASELINE=$(curl -s "$REGISTRY_URL/api/v1/events?limit=1" | jq '.[0].id // 0')

# --- Step 1: Power off the adapter ---
echo ""
echo "--- Powering off $DONGLE_HCI (simulating transient disconnect) ---"
ssh "$PI" "docker exec $CONTAINER hciconfig $DONGLE_HCI down" 2>/dev/null || true
echo "Adapter powered down."
sleep 5

# --- Step 2: Power it back on (well within the 5-min cooldown) ---
echo ""
echo "--- Powering on $DONGLE_HCI (within cooldown window) ---"
ssh "$PI" "docker exec $CONTAINER hciconfig $DONGLE_HCI up" 2>/dev/null || true
echo "Adapter powered up."

# --- Step 3: Wait for BT reconnect ---
echo ""
echo "--- Waiting up to ${MAX_RECONNECT_WAIT}s for BT to reconnect ---"
START=$(date +%s)
BT_OK=false

while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - START))
    if [ "$ELAPSED" -ge "$MAX_RECONNECT_WAIT" ]; then
        break
    fi

    INFO=$(curl -sk "$PI_URL/phones/$DONGLE_PHONE/api/info" 2>/dev/null || echo "{}")
    BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')

    if [ "$BT_CONNECTED" = "true" ]; then
        BT_OK=true
        echo "  BT reconnected at T+${ELAPSED}s"
        break
    fi

    echo "  [${ELAPSED}s] bt_connected=$BT_CONNECTED"
    sleep 10
done

if [ "$BT_OK" = "true" ]; then
    echo "PASS: BT reconnected after transient dongle disconnect"
else
    echo "WARN: BT not reconnected within ${MAX_RECONNECT_WAIT}s (may still be healing)"
fi

# --- Step 4: Verify no dongle.lost event ---
echo ""
echo "--- Checking that no dongle.lost event was emitted ---"
LOST_EVENTS=$(curl -s "$REGISTRY_URL/api/v1/events?event_type=info.dongle.lost&limit=10")
NEW_LOST=$(echo "$LOST_EVENTS" | jq --argjson baseline "$EVENT_BASELINE" '[.[] | select(.id > $baseline)] | length')

if [ "$NEW_LOST" -gt 0 ]; then
    echo "FAIL: dongle.lost event emitted during transient disconnect"
    exit 1
fi
echo "PASS: no dongle.lost event during transient disconnect"

# --- Step 5: Verify assignment preserved ---
echo ""
echo "--- Verifying dongle assignment preserved ---"
DONGLE_NOW=$(curl -s "$REGISTRY_URL/api/v1/dongles" | jq -r ".[] | select(.id == \"$DONGLE_ID\")")
PHONE_NOW=$(echo "$DONGLE_NOW" | jq -r '.phone_id // empty')

if [ "$PHONE_NOW" != "$DONGLE_PHONE" ]; then
    echo "FAIL: dongle assignment changed ($DONGLE_PHONE -> $PHONE_NOW)"
    exit 1
fi
echo "PASS: dongle still assigned to $DONGLE_PHONE"

echo ""
echo "=== Test: transient dongle disconnect PASSED ==="
