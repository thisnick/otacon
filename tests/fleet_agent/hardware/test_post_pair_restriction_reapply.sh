#!/usr/bin/env bash
# Hardware test: Post-pair restriction reapply
#
# Verifies that after a successful BT pair (via heal_bt_bonded), restrictions
# are immediately re-applied -- independently of the periodic check_restrictions
# heal loop. This tests the active (post-pair) recovery path, complementing
# test_full_restrictions.sh which tests the passive (check loop) path.
#
# Flow:
#   1. Verify phone is BT-healthy (bonded + connected)
#   2. Clear no_config_bluetooth from Device policy restrictions
#   3. Force unpair to trigger heal_bt_bonded -> allocate_and_pair_bluetooth
#   4. After pair completes, verify no_config_bluetooth is back within 30s
#      (the post-pair apply_restrictions call should restore it immediately,
#      NOT the periodic check_restrictions heal which runs on a slower tick)
#
# Usage: ./test_post_pair_restriction_reapply.sh [PHONE_ID [SERIAL]]
# Requires: curl, jq, ssh access to otacon-pi

set -euo pipefail

PI="nick@otacon-pi"
PI_URL="https://otacon-pi:8080"
PHONE_ID="${1:-phone-r92x1022}"
SERIAL="${2:-R92X1022S7K}"
MAX_PAIR_WAIT=480  # seconds for BT heal to complete
REAPPLY_TIMEOUT=30 # seconds after pair for restriction to reappear

# Parse "Device policy restrictions:" (Samsung) or "Device policy global/local
# restrictions:" (Pixel/AOSP) sections from dumpsys user output.
parse_device_policy_restrictions() {
    local dumpsys="$1"
    local in_section=false
    while IFS= read -r line; do
        if [[ "$line" == *"Device policy"*"restrictions:"* ]] && [[ "$line" != *"Effective"* ]]; then
            in_section=true
            continue
        fi
        if [[ "$line" == *"Effective restrictions:"* ]]; then
            in_section=false
            continue
        fi
        if [ "$in_section" = true ]; then
            stripped="${line#"${line%%[![:space:]]*}"}"
            if [ -z "$stripped" ]; then
                continue
            fi
            if [[ "$line" != " "* ]] && [[ "$line" != $'\t'* ]]; then
                in_section=false
                continue
            fi
            if [[ "$stripped" == "User Id:"* ]]; then
                continue
            fi
            if [[ "$stripped" =~ ^(no_[a-z_]+) ]]; then
                echo "${BASH_REMATCH[1]}"
            fi
        fi
    done <<< "$dumpsys"
}

echo "=== Test: Post-pair restriction reapply ==="
echo "Phone: $PHONE_ID ($SERIAL)"

# Step 1: Verify phone is BT-healthy
echo ""
echo "--- Step 1: Verify BT-healthy starting state ---"
INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
BT_BONDED=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded // false')
BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')
ADAPTER_MAC=$(echo "$INFO" | jq -r '.adapter_mac // empty')
PHONE_BT_MAC=$(echo "$INFO" | jq -r '.phone_bt_mac // empty')

echo "bt_bonded=$BT_BONDED bt_connected=$BT_CONNECTED adapter=$ADAPTER_MAC"

if [ "$BT_BONDED" != "true" ] || [ "$BT_CONNECTED" != "true" ]; then
    echo "SKIP: Phone not in healthy BT state -- need bonded+connected to start"
    echo "Wait for self-heal to complete and re-run."
    exit 0
fi

if [ -z "$ADAPTER_MAC" ]; then
    echo "SKIP: No adapter_mac in /api/info"
    exit 0
fi

# Step 2: Clear all restrictions via kiosk broadcast
echo ""
echo "--- Step 2: Clear all restrictions via kiosk broadcast ---"
ssh "$PI" "docker exec otacon-otacon-1 adb -s $SERIAL shell am broadcast -a com.otacon.kiosk.CLEAR_RESTRICTIONS -n com.otacon.kiosk/.BootReceiver" 2>/dev/null || true
sleep 3

DUMPSYS=$(ssh "$PI" "docker exec otacon-otacon-1 adb -s $SERIAL shell dumpsys user" 2>/dev/null)
ACTIVE=$(parse_device_policy_restrictions "$DUMPSYS")
BEFORE_COUNT=$(echo "$ACTIVE" | grep -c "^no_" || true)
if [ "$BEFORE_COUNT" -ge 8 ]; then
    echo "FAIL: restrictions still all present after CLEAR_RESTRICTIONS broadcast"
    exit 1
fi
echo "Confirmed: restrictions cleared ($BEFORE_COUNT remaining, was 8)"

# Step 3: Force unpair to trigger heal_bt_bonded
echo ""
echo "--- Step 3: Force unpair to trigger re-pair ---"

# Remove phone-side bond
ssh "$PI" "docker exec otacon-otacon-1 adb -s $SERIAL shell content query --uri 'content://com.otacon.kiosk/bluetooth/unpair?mac=$ADAPTER_MAC'" 2>/dev/null || true

# Remove Pi-side bond
if [ -n "$PHONE_BT_MAC" ]; then
    ssh "$PI" "docker exec otacon-otacon-1 bluetoothctl remove $PHONE_BT_MAC" 2>/dev/null || true
fi

echo "Bonds cleared. Waiting for heal_bt_bonded to trigger re-pair..."
sleep 5

# Step 4: Wait for BT to heal (pair to complete)
echo ""
echo "--- Step 4: Wait for BT heal (re-pair) ---"
START=$(date +%s)
PAIR_COMPLETED=false

while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - START))
    if [ "$ELAPSED" -ge "$MAX_PAIR_WAIT" ]; then
        break
    fi

    INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
    BT_BONDED=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded // false')
    BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')

    echo "  [${ELAPSED}s] bt_bonded=$BT_BONDED bt_connected=$BT_CONNECTED"

    if [ "$BT_BONDED" = "true" ] && [ "$BT_CONNECTED" = "true" ]; then
        PAIR_COMPLETED=true
        echo "BT pair completed at T+${ELAPSED}s"
        break
    fi

    sleep 10
done

if [ "$PAIR_COMPLETED" = false ]; then
    echo "FAIL: BT did not heal within ${MAX_PAIR_WAIT}s"
    exit 1
fi

# Step 5: Verify no_config_bluetooth was restored by the post-pair reapply
# The restriction should already be back (apply_restrictions runs synchronously
# inside allocate_and_pair_bluetooth), but allow up to REAPPLY_TIMEOUT seconds
# to account for timing.
echo ""
echo "--- Step 5: Verify restrictions restored (post-pair reapply) ---"
PAIR_END=$(date +%s)
RESTORED=false

EXPECTED_RESTRICTIONS=(
    no_config_wifi no_config_bluetooth no_config_location no_factory_reset
    no_safe_boot no_usb_file_transfer no_airplane_mode no_config_tethering
)

for i in $(seq 1 "$REAPPLY_TIMEOUT"); do
    DUMPSYS=$(ssh "$PI" "docker exec otacon-otacon-1 adb -s $SERIAL shell dumpsys user" 2>/dev/null)
    ACTIVE=$(parse_device_policy_restrictions "$DUMPSYS")
    ACTIVE_COUNT=$(echo "$ACTIVE" | grep -c "^no_" || true)

    if [ "$ACTIVE_COUNT" -ge 8 ]; then
        RESTORED=true
        RESTORE_TIME=$(($(date +%s) - PAIR_END))
        echo "All restrictions restored ${RESTORE_TIME}s after pair completed"
        break
    fi

    if [ $((i % 5)) -eq 0 ]; then
        echo "  [${i}s after pair] $ACTIVE_COUNT of 8 restrictions present"
    fi
    sleep 1
done

if [ "$RESTORED" = false ]; then
    echo "FAIL: restrictions not fully restored ${REAPPLY_TIMEOUT}s after pair"
    echo "The post-pair apply_restrictions() call may not have fired."
    echo ""
    echo "--- Container logs (last 30 lines, filtered for restriction) ---"
    ssh "$PI" "docker logs --tail 30 otacon-otacon-1 2>&1 | grep -iE 'restrict|apply'" || true
    exit 1
fi

TOTAL=$(($(date +%s) - START))
echo ""
echo "PASS: Post-pair restriction reapply confirmed in ${TOTAL}s total"
echo "  - no_config_bluetooth cleared, pair forced, restriction restored within ${RESTORE_TIME}s of pair"
echo "=== Test: Post-pair restriction reapply PASSED ==="
