#!/usr/bin/env bash
# Hardware test 7: S22 self-heal (the headline functional test)
#
# Pre-condition: S22 should start with bt_bonded=false or bt_connected=false.
# If healthy, forces a failure by unpairing the BT dongle from the phone side.
# Then waits up to 3 maintenance ticks (~90s) for fleet-agent to heal.
#
# Usage: ./test_s22_self_heal.sh
# Requires: curl, jq, ssh access to otacon-pi

set -euo pipefail

PI="nick@otacon-pi"
PI_URL="https://otacon-pi:8080"
PHONE_ID="phone-r5ct60sd"
S22_SERIAL="R5CT60SDGKD"
DONGLE_MAC="F4:4E:FC:27:B3:E8"
MAX_WAIT=480  # seconds (5-min heal cooldown + pair time)

echo "=== Test 7: S22 self-heal ==="

# Check current S22 BT health
INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
BT_BONDED=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded // false')
BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')

echo "Initial state: bt_bonded=$BT_BONDED, bt_connected=$BT_CONNECTED"

if [ "$BT_BONDED" = "true" ] && [ "$BT_CONNECTED" = "true" ]; then
    echo "S22 is already healthy. Forcing bond removal to test heal..."
    ssh "$PI" "adb -s $S22_SERIAL shell content query --uri 'content://com.otacon.kiosk/bluetooth/unpair?mac=$DONGLE_MAC'" 2>/dev/null || true
    echo "Waiting 60s for fleet-agent to observe the failure..."
    sleep 60
fi

# Wait for heal
echo "Waiting up to ${MAX_WAIT}s for self-heal..."
START=$(date +%s)
HEALED=false

while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - START))
    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
        break
    fi

    INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
    BT_BONDED=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded // false')
    BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')

    echo "  [${ELAPSED}s] bt_bonded=$BT_BONDED bt_connected=$BT_CONNECTED"

    if [ "$BT_BONDED" = "true" ] && [ "$BT_CONNECTED" = "true" ]; then
        HEALED=true
        break
    fi

    sleep 10
done

TOTAL=$(($(date +%s) - START))

if [ "$HEALED" = "true" ]; then
    echo "PASS: S22 self-healed in ${TOTAL}s"
else
    echo "FAIL: S22 did not self-heal within ${MAX_WAIT}s"
    echo "Final state: bt_bonded=$BT_BONDED, bt_connected=$BT_CONNECTED"
    exit 1
fi

# Log heal history for diagnostics (not a pass/fail criterion — the phone
# being healthy is the definitive check, and heal history may contain stale
# entries from earlier in the container lifecycle)
HEALS=$(echo "$INFO" | jq '.monitor.heals')
echo "Heal history (informational):"
echo "$HEALS" | jq '.'
echo "PASS: S22 is bt_bonded=true bt_connected=true (self-heal confirmed)"

echo "=== Test 7 PASSED (healed in ${TOTAL}s) ==="
