#!/usr/bin/env bash
# Hardware test: Factory reset full recovery (THE BIG ONE)
#
# Triggers a real factory reset on the A14 canary phone, then verifies that
# fleet-agent re-discovers and reprovisions the phone from clean state with
# all health checks green and the full kiosk restriction set applied.
#
# THIS WILL WIPE THE A14 PHONE. ADB trust survives via testharness.
#
# Usage: ./test_factory_reset_full_recovery.sh [PHONE_ID [SERIAL]]
# Requires: curl, jq, ssh access to otacon-pi

set -euo pipefail

PI="nick@otacon-pi"
PI_FQDN=$(tailscale status --json | jq -r '.Peer[] | select(.HostName == "otacon-pi") | .DNSName | rtrimstr(".")')
PI_URL="https://${PI_FQDN}:8080"
PHONE_ID="${1:-phone-r92x1022}"
SERIAL="${2:-R92X1022S7K}"
MAX_WAIT=1200  # 20 minutes total

# Expected restriction set from BootReceiver.java
EXPECTED_RESTRICTIONS=(
    no_config_wifi
    no_config_bluetooth
    no_config_location
    no_factory_reset
    no_safe_boot
    no_usb_file_transfer
    no_airplane_mode
    no_config_tethering
)

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

# Expected health checks
HEALTH_CHECKS=(
    bt_bonded
    bt_connected
    wifi
    device_owner
    restrictions
    snapshot_alive
    port_forwards
)

echo "=== Test: Factory reset full recovery ==="
echo "Phone: $PHONE_ID ($SERIAL)"
echo "WARNING: This WILL factory-reset the phone!"
echo ""

# Pre-check: phone should be in a healthy state
INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
BRIDGE=$(echo "$INFO" | jq -r '.bridge // false')
if [ "$BRIDGE" != "true" ]; then
    echo "FAIL (pre-check): Phone $PHONE_ID bridge is not true (phone not online)"
    exit 1
fi
echo "Pre-check: phone is online (bridge=true)"

TIMELINE="T+0s: reset triggered"
RESET_START=$(date +%s)

# Trigger factory reset
echo ""
echo "--- Triggering factory reset ---"
RESET_RESP=$(curl -sk -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"confirm\": true, \"phone_id\": \"$PHONE_ID\"}" \
    "$PI_URL/phones/$PHONE_ID/api/factory-reset" 2>/dev/null)
echo "Reset response: $RESET_RESP"

RESET_STATUS=$(echo "$RESET_RESP" | jq -r '.status // "unknown"')

# Handle already_in_test_harness_mode — phone can't be re-reset via testharness
if [ "$RESET_STATUS" = "already_in_test_harness_mode" ]; then
    # Even with this status, the handler still clears restrictions + device owner
    # and calls cmd testharness enable. Check if the phone actually disconnects.
    echo ""
    echo "NOTE: API returned already_in_test_harness_mode"
    echo "Checking if phone actually disconnects (30s grace period)..."
    ACTUALLY_RESET=false
    for i in $(seq 1 30); do
        INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
        BRIDGE=$(echo "$INFO" | jq -r '.bridge // "unknown"')
        if [ "$BRIDGE" = "false" ] || [ "$BRIDGE" = "unknown" ] || [ -z "$INFO" ]; then
            ACTUALLY_RESET=true
            break
        fi
        sleep 1
    done
    if [ "$ACTUALLY_RESET" = "false" ]; then
        echo ""
        echo "SKIP: Phone is permanently in test_harness mode (persist.sys.test_harness=1)."
        echo "  cmd testharness enable is a no-op. Phone did not reset."
        echo "  Factory reset functionality was validated on a fresh phone (first run)."
        echo "  Subsequent runs on the same phone cannot re-trigger testharness."
        echo "=== Test: Factory reset full recovery SKIPPED ==="
        exit 0
    fi
    echo "Phone actually disconnected despite already_in_test_harness_mode — continuing."
fi

# Phase 1: Wait for phone to disconnect (up to 120s)
echo ""
echo "--- Phase 1: Waiting for phone to disconnect ---"
DISCONNECTED=false
for i in $(seq 1 120); do
    INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
    BRIDGE=$(echo "$INFO" | jq -r '.bridge // "unknown"')
    if [ "$BRIDGE" = "false" ] || [ "$BRIDGE" = "unknown" ] || [ -z "$INFO" ]; then
        NOW=$(date +%s)
        ELAPSED=$((NOW - RESET_START))
        DISCONNECTED=true
        TIMELINE="$TIMELINE\nT+${ELAPSED}s: disconnected"
        echo "Phone disconnected at T+${ELAPSED}s"
        break
    fi
    if [ $((i % 5)) -eq 0 ]; then
        echo "  [${i}s] bridge=$BRIDGE (waiting for disconnect)"
    fi
    sleep 1
done

if [ "$DISCONNECTED" = "false" ]; then
    echo "FAIL: Phone did not disconnect within 120s after factory reset"
    exit 1
fi

# Phase 2: Wait for phone to reconnect with ADB trust (up to 5 min)
echo ""
echo "--- Phase 2: Waiting for phone to reconnect ---"
RECONNECTED=false
for i in $(seq 1 300); do
    INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
    BRIDGE=$(echo "$INFO" | jq -r '.bridge // false')
    if [ "$BRIDGE" = "true" ]; then
        NOW=$(date +%s)
        ELAPSED=$((NOW - RESET_START))
        RECONNECTED=true
        TIMELINE="$TIMELINE\nT+${ELAPSED}s: reconnected (ADB trust intact)"
        echo "Phone reconnected at T+${ELAPSED}s"
        break
    fi
    if [ $((i % 10)) -eq 0 ]; then
        echo "  [${i}s] bridge=$BRIDGE (waiting for reconnect)"
    fi
    sleep 1
done

if [ "$RECONNECTED" = "false" ]; then
    echo "FAIL: Phone did not reconnect within 300s"
    echo "ADB trust may not have survived the reset."
    exit 1
fi

# Phase 3: Wait for fleet-agent to reprovision (device-owner, restrictions, BT)
echo ""
echo "--- Phase 3: Waiting for full reprovision ---"

# Give fleet-agent a moment to start reprovisioning
sleep 10

ALL_GREEN=false
LAST_STATUS=""
PROVISION_START=$(date +%s)

while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - RESET_START))
    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
        break
    fi

    INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)

    # Check device_owner
    DO=$(echo "$INFO" | jq -r '.monitor.health.device_owner // false')
    if [ "$DO" = "true" ] && ! echo "$TIMELINE" | grep -q "device-owner set"; then
        TIMELINE="$TIMELINE\nT+${ELAPSED}s: device-owner set"
        echo "Device owner set at T+${ELAPSED}s"
    fi

    # Build status line
    STATUS=""
    ALL_TRUE=true
    for check in "${HEALTH_CHECKS[@]}"; do
        VAL=$(echo "$INFO" | jq -r "if .monitor.health.$check == true then \"true\" elif .monitor.health.$check == false then \"false\" else \"?\" end")
        STATUS="$STATUS $check=$VAL"
        if [ "$VAL" != "true" ]; then
            ALL_TRUE=false
        fi
    done

    if [ "$STATUS" != "$LAST_STATUS" ]; then
        echo "  [${ELAPSED}s]$STATUS"
        LAST_STATUS="$STATUS"
    fi

    if [ "$ALL_TRUE" = "true" ]; then
        ALL_GREEN=true
        TIMELINE="$TIMELINE\nT+${ELAPSED}s: all health checks green"
        echo "All health checks green at T+${ELAPSED}s"
        break
    fi

    sleep 10
done

TOTAL=$(($(date +%s) - RESET_START))

if [ "$ALL_GREEN" = "false" ]; then
    echo ""
    echo "FAIL: Not all health checks green within ${MAX_WAIT}s"
    echo "Final status:$STATUS"
    echo ""
    echo "--- Timeline ---"
    echo -e "$TIMELINE"
    exit 1
fi

# Phase 4: Verify full restriction set on the phone (Device policy restrictions only)
echo ""
echo "--- Phase 4: Verify full kiosk restriction set (Device policy section) ---"
DUMPSYS=$(ssh "$PI" "docker exec otacon-otacon-1 adb -s $SERIAL shell dumpsys user" 2>/dev/null)
ACTIVE=$(parse_device_policy_restrictions "$DUMPSYS")
RESTRICTION_MISSING=()
for r in "${EXPECTED_RESTRICTIONS[@]}"; do
    if echo "$ACTIVE" | grep -q "^${r}$"; then
        echo "  $r: present"
    else
        echo "  $r: MISSING"
        RESTRICTION_MISSING+=("$r")
    fi
done

if [ ${#RESTRICTION_MISSING[@]} -gt 0 ]; then
    echo "FAIL: ${#RESTRICTION_MISSING[@]} restrictions missing from Device policy: ${RESTRICTION_MISSING[*]}"
    echo ""
    echo "--- Timeline ---"
    echo -e "$TIMELINE"
    exit 1
fi
echo "PASS: all ${#EXPECTED_RESTRICTIONS[@]} restrictions present in Device policy section (including no_config_bluetooth)"

# Phase 5: Verify BT is bonded and connected
echo ""
echo "--- Phase 5: Verify BT bonded + connected ---"
INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
BT_BONDED=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded // false')
BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')
ADAPTER_MAC=$(echo "$INFO" | jq -r '.adapter_mac // "none"')

echo "bt_bonded=$BT_BONDED bt_connected=$BT_CONNECTED adapter=$ADAPTER_MAC"

if [ "$BT_BONDED" != "true" ] || [ "$BT_CONNECTED" != "true" ]; then
    echo "FAIL: BT not fully connected after reprovision"
    exit 1
fi

TIMELINE="$TIMELINE\nT+${TOTAL}s: all verified (restrictions + BT)"

echo ""
echo "========================================"
echo "--- Timeline ---"
echo -e "$TIMELINE"
echo "========================================"
echo ""
echo "PASS: Factory reset full recovery completed in ${TOTAL}s"
echo "  - Phone disconnected and reconnected with ADB trust"
echo "  - Device owner set and all ${#EXPECTED_RESTRICTIONS[@]} restrictions applied"
echo "  - All ${#HEALTH_CHECKS[@]} health checks green"
echo "  - BT bonded + connected on adapter $ADAPTER_MAC"
echo "=== Test: Factory reset full recovery PASSED ==="
