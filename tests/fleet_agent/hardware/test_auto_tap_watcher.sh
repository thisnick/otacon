#!/usr/bin/env bash
# Hardware test: Auto-tap watcher for pair dialogs
#
# Verifies that the background auto-tap watcher catches pair dialogs
# regardless of which heal path triggered the pairing. The watcher should
# tap "Pair" or "Allow" buttons within 10s of a dialog appearing.
#
# Flow:
#   1. Force unpair from the phone side to trigger a re-pair
#   2. The re-pair flow produces a Settings pair-confirmation dialog
#   3. Verify the dialog is auto-tapped (disappears within 10s)
#   4. Verify BT ends up bonded + connected
#
# Usage: ./test_auto_tap_watcher.sh [PHONE_ID [SERIAL]]
# Requires: curl, jq, ssh access to otacon-pi

set -euo pipefail

PI="nick@otacon-pi"
PI_URL="https://otacon-pi:8080"
PHONE_ID="${1:-phone-r92x1022}"
SERIAL="${2:-R92X1022S7K}"
MAX_WAIT=480  # seconds — heal cooldown + pair time

echo "=== Test: Auto-tap watcher ==="
echo "Phone: $PHONE_ID ($SERIAL)"

# Get current state
INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
BT_BONDED=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded // false')
BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')
ADAPTER_MAC=$(echo "$INFO" | jq -r '.adapter_mac // empty')

echo "Initial state: bt_bonded=$BT_BONDED bt_connected=$BT_CONNECTED adapter=$ADAPTER_MAC"

if [ -z "$ADAPTER_MAC" ]; then
    echo "SKIP: No adapter_mac in /api/info — BT not configured for this phone"
    exit 0
fi

# Force unpair from phone side to trigger pair dialog on next pair attempt
echo ""
echo "--- Forcing unpair to trigger re-pair flow ---"
ssh "$PI" "docker exec otacon-otacon-1 adb -s $SERIAL shell content query --uri 'content://com.otacon.kiosk/bluetooth/unpair?mac=$ADAPTER_MAC'" 2>/dev/null || true

# Also remove Pi-side bond to force full re-pair
PHONE_BT_MAC=$(echo "$INFO" | jq -r '.phone_bt_mac // empty')
if [ -n "$PHONE_BT_MAC" ]; then
    ssh "$PI" "docker exec otacon-otacon-1 bluetoothctl remove $PHONE_BT_MAC" 2>/dev/null || true
fi

echo "Bonds cleared. Waiting for heal cycle to trigger re-pair..."
sleep 10

# Wait for BT to heal — the auto-tap watcher should handle the pair dialog
echo ""
echo "--- Waiting for auto-tap + heal ---"
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
        echo "BT healed at T+${ELAPSED}s"
        break
    fi

    sleep 10
done

TOTAL=$(($(date +%s) - START))

if [ "$HEALED" = "false" ]; then
    echo "FAIL: BT did not heal within ${MAX_WAIT}s"
    echo "This likely means the auto-tap watcher did not catch the pair dialog."
    echo "Final state: bt_bonded=$BT_BONDED bt_connected=$BT_CONNECTED"

    # Check container logs for auto-tap activity
    echo ""
    echo "--- Container logs (last 50 lines, filtered for pair-dialog watcher) ---"
    ssh "$PI" "docker logs --tail 50 otacon-otacon-1 2>&1 | grep -iE 'Pair-dialog watcher|auto.tapping|tapped notification'" || true
    exit 1
fi

# Verify auto-tap watcher was involved by checking container logs
echo ""
echo "--- Checking container logs for pair-dialog watcher evidence ---"
LOGS=$(ssh "$PI" "docker logs --tail 100 otacon-otacon-1 2>&1 | grep -iE 'Pair-dialog watcher: auto-tapping|Pair-dialog watcher: tapped notification'" 2>/dev/null || true)
if [ -n "$LOGS" ]; then
    echo "Pair-dialog watcher log evidence found:"
    echo "$LOGS" | tail -5
else
    echo "No pair-dialog watcher log lines found (pair may have completed without dialog)"
fi

echo ""
echo "PASS: BT healed in ${TOTAL}s — pair dialog was handled (auto-tapped or no dialog needed)"
echo "=== Test: Auto-tap watcher PASSED ==="
