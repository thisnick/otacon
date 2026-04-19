#!/usr/bin/env bash
# Hardware test: BT bonded split (Pi vs phone side visibility)
#
# Forces a phone-side unpair and verifies the API reports:
#   bt_bonded=false, bt_bonded_pi=true, bt_bonded_phone=false
# within one maintenance tick (30s).
#
# Usage: ./test_bt_bonded_split.sh [PHONE_ID [SERIAL]]
# Requires: curl, jq, ssh access to otacon-pi

set -euo pipefail

PI="nick@otacon-pi"
PI_FQDN=$(tailscale status --json | jq -r '.Peer[] | select(.HostName == "otacon-pi") | .DNSName | rtrimstr(".")')
PI_URL="https://${PI_FQDN}:8080"
PHONE_ID="${1:-phone-r5ct60sd}"
SERIAL="${2:-R5CT60SDGKD}"
MAX_WAIT=120

echo "=== Test: BT bonded split (pi/phone) ==="
echo "Phone: $PHONE_ID ($SERIAL)"

# Get current state
INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
BT_BONDED=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded // false')
BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')

echo "Initial state: bt_bonded=$BT_BONDED bt_connected=$BT_CONNECTED"

if [ "$BT_BONDED" != "true" ] || [ "$BT_CONNECTED" != "true" ]; then
    echo "SKIP: Phone not in healthy BT state (need bonded+connected to start)"
    exit 0
fi

ADAPTER_MAC=$(echo "$INFO" | jq -r '.adapter_mac // empty')
if [ -z "$ADAPTER_MAC" ]; then
    echo "SKIP: Cannot determine adapter_mac from /api/info"
    exit 0
fi
echo "Adapter: $ADAPTER_MAC"

# Step 1: Force phone-side unpair (Pi-side bond remains)
echo ""
echo "--- Step 1: Force phone-side unpair ---"
ssh "$PI" "docker exec otacon-otacon-1 adb -s $SERIAL shell \
  \"content query --uri 'content://com.otacon.kiosk/bluetooth/unpair?mac=$ADAPTER_MAC'\"" \
  2>/dev/null || true
sleep 2
echo "Phone-side unpair issued."

# Step 2: Wait for maintenance tick to detect asymmetry
echo ""
echo "--- Step 2: Wait for API to report bt_bonded_pi=true, bt_bonded_phone=false ---"

START=$(date +%s)
DETECTED=false

while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - START))
    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
        break
    fi

    INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
    BT_BONDED=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded // "null"')
    BT_PI=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded_pi // "null"')
    BT_PHONE=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded_phone // "null"')

    echo "  [${ELAPSED}s] bt_bonded=$BT_BONDED bt_bonded_pi=$BT_PI bt_bonded_phone=$BT_PHONE"

    if [ "$BT_BONDED" = "false" ] && [ "$BT_PI" = "true" ] && [ "$BT_PHONE" = "false" ]; then
        DETECTED=true
        echo "Asymmetric state detected at T+${ELAPSED}s"
        break
    fi

    sleep 10
done

if [ "$DETECTED" = "true" ]; then
    echo "PASS: API correctly reports asymmetric bond (pi=true, phone=false, combined=false)"
else
    echo "FAIL: Did not observe expected asymmetric state within ${MAX_WAIT}s"
    echo "Final: bt_bonded=$BT_BONDED bt_bonded_pi=$BT_PI bt_bonded_phone=$BT_PHONE"
    exit 1
fi

# Step 3: Wait for self-heal to restore full bond (optional — don't fail if slow)
echo ""
echo "--- Step 3: Wait for self-heal to restore (best-effort) ---"
HEAL_START=$(date +%s)
HEALED=false
while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - HEAL_START))
    if [ "$ELAPSED" -ge 300 ]; then
        break
    fi

    INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
    BT_BONDED=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded // false')
    BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')

    if [ "$BT_BONDED" = "true" ] && [ "$BT_CONNECTED" = "true" ]; then
        HEALED=true
        echo "  Self-healed at T+${ELAPSED}s"
        break
    fi
    sleep 15
done

if [ "$HEALED" = "true" ]; then
    echo "PASS: Full BT bond restored"
else
    echo "WARN: BT not fully healed yet (may take longer)"
fi

echo ""
echo "=== Test: BT bonded split PASSED ==="
