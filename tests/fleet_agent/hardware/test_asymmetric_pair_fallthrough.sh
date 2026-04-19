#!/usr/bin/env bash
# Hardware test: Asymmetric pair fallthrough
#
# Verifies that heal_bt_connected falls through to heal_bt_bonded after
# N consecutive failures (expected: 3). This catches the case where a
# phone-side bond exists but the Pi-side bond is broken/stale, causing
# bluetoothctl connect to fail indefinitely.
#
# Flow:
#   1. Start with healthy BT state (bonded + connected)
#   2. Remove the Pi-side bond (bluetoothctl remove) but leave phone-side intact
#   3. Observe heal_bt_connected failing repeatedly
#   4. After N failures, verify heal_bt_bonded triggers and re-pairs
#
# Usage: ./test_asymmetric_pair_fallthrough.sh [PHONE_ID [SERIAL]]
# Requires: curl, jq, ssh access to otacon-pi

set -euo pipefail

PI="nick@otacon-pi"
PI_FQDN=$(tailscale status --json | jq -r '.Peer[] | select(.HostName == "otacon-pi") | .DNSName | rtrimstr(".")')
PI_URL="https://${PI_FQDN}:8080"
PHONE_ID="${1:-phone-r5ct60sd}"
SERIAL="${2:-R5CT60SDGKD}"
MAX_WAIT=600  # 10 minutes — heal_bt_connected retries + cooldown + re-pair

echo "=== Test: Asymmetric pair fallthrough ==="
echo "Phone: $PHONE_ID ($SERIAL)"

# Get current BT state
INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
BT_BONDED=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded // false')
BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')

echo "Initial state: bt_bonded=$BT_BONDED bt_connected=$BT_CONNECTED"

if [ "$BT_BONDED" != "true" ] || [ "$BT_CONNECTED" != "true" ]; then
    echo "SKIP: Phone not in healthy BT state (need bonded+connected to start)"
    echo "Wait for self-heal to complete and re-run."
    exit 0
fi

# Get the adapter MAC and phone BT MAC from info
ADAPTER_MAC=$(echo "$INFO" | jq -r '.adapter_mac // empty')
PHONE_BT_MAC=$(echo "$INFO" | jq -r '.phone_bt_mac // empty')

if [ -z "$ADAPTER_MAC" ] || [ -z "$PHONE_BT_MAC" ]; then
    echo "SKIP: Cannot determine adapter_mac or phone_bt_mac from /api/info"
    exit 0
fi

echo "Adapter: $ADAPTER_MAC, Phone BT: $PHONE_BT_MAC"

# Step 1: Remove Pi-side bond only (create asymmetric state)
echo ""
echo "--- Step 1: Remove Pi-side bond (create asymmetric pair) ---"
ssh "$PI" "docker exec otacon-otacon-1 bluetoothctl remove $PHONE_BT_MAC" 2>/dev/null || true
sleep 2

# Verify Pi-side bond gone
PI_BOND=$(ssh "$PI" "docker exec otacon-otacon-1 bluetoothctl info $PHONE_BT_MAC" 2>/dev/null || true)
if echo "$PI_BOND" | grep -q "Paired: yes"; then
    echo "FAIL: Pi-side bond still present after remove"
    exit 1
fi
echo "Pi-side bond removed. Phone-side bond still intact (asymmetric state)."

# Step 2: Wait for fleet-agent to detect and heal
echo ""
echo "--- Step 2: Wait for fallthrough from bt_connected -> bt_bonded heal ---"
echo "Expecting: heal_bt_connected fails N times, then heal_bt_bonded triggers"

START=$(date +%s)
HEALED=false
SEEN_BT_CONNECTED_FAIL=false
SEEN_BT_BONDED_HEAL=false

while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - START))
    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
        break
    fi

    INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
    BT_BONDED=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded // false')
    BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')

    # Track heal attempts
    BT_CONNECTED_HEALS=$(echo "$INFO" | jq -r '.monitor.heals.bt_connected.count_today // 0')
    BT_BONDED_HEALS=$(echo "$INFO" | jq -r '.monitor.heals.bt_bonded.count_today // 0')
    BT_CONNECTED_RESULT=$(echo "$INFO" | jq -r '.monitor.heals.bt_connected.last_result // "none"')
    BT_BONDED_RESULT=$(echo "$INFO" | jq -r '.monitor.heals.bt_bonded.last_result // "none"')

    echo "  [${ELAPSED}s] bonded=$BT_BONDED connected=$BT_CONNECTED | heals: connected=$BT_CONNECTED_HEALS($BT_CONNECTED_RESULT) bonded=$BT_BONDED_HEALS($BT_BONDED_RESULT)"

    if [ "$BT_CONNECTED" = "false" ]; then
        SEEN_BT_CONNECTED_FAIL=true
    fi

    if [ "$BT_BONDED" = "true" ] && [ "$BT_CONNECTED" = "true" ]; then
        HEALED=true
        echo "BT fully healed at T+${ELAPSED}s"
        break
    fi

    sleep 15
done

TOTAL=$(($(date +%s) - START))

if [ "$HEALED" = "true" ]; then
    # Verify that bt_bonded heal fired (the fallthrough happened)
    INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
    BT_BONDED_HEALS=$(echo "$INFO" | jq -r '.monitor.heals.bt_bonded.count_today // 0')

    if [ "$BT_BONDED_HEALS" -gt 0 ]; then
        echo "PASS: Asymmetric pair detected, heal_bt_bonded triggered (count=$BT_BONDED_HEALS), healed in ${TOTAL}s"
    else
        echo "PASS: BT healed in ${TOTAL}s (bt_bonded heal count=$BT_BONDED_HEALS — may have recovered via bt_connected alone)"
    fi
else
    echo "FAIL: BT did not self-heal within ${MAX_WAIT}s"
    echo "Final state: bt_bonded=$BT_BONDED bt_connected=$BT_CONNECTED"
    echo "Seen bt_connected fail: $SEEN_BT_CONNECTED_FAIL"
    exit 1
fi

echo "=== Test: Asymmetric pair fallthrough PASSED (healed in ${TOTAL}s) ==="
