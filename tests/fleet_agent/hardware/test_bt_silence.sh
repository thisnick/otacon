#!/usr/bin/env bash
# Hardware test: BT silence-by-default verification
#
# Verifies that all Bluetooth adapters have Discoverable=false at steady state.
# Specifically checks hci0, which was previously the leak.
#
# Usage: ./test_bt_silence.sh
# Requires: ssh access to otacon-pi, bluetoothctl inside container

set -euo pipefail

PI="nick@otacon-pi"
CONTAINER="otacon-otacon-1"

echo "=== Test: BT silence-by-default ==="

# Step 1: Check all adapters have Discoverable: no at steady state
echo ""
echo "--- Step 1: All adapters must have Discoverable: no ---"

BTCTL_OUTPUT=$(ssh "$PI" "docker exec $CONTAINER bluetoothctl show" 2>/dev/null || true)

if [ -z "$BTCTL_OUTPUT" ]; then
    echo "FAIL: bluetoothctl show returned empty output"
    exit 1
fi

# Get list of all controller addresses
CONTROLLERS=$(ssh "$PI" "docker exec $CONTAINER bluetoothctl list" 2>/dev/null || true)

if [ -z "$CONTROLLERS" ]; then
    echo "FAIL: no bluetooth controllers found"
    exit 1
fi

echo "Controllers found:"
echo "$CONTROLLERS"
echo ""

FAIL=false
while IFS= read -r line; do
    # Parse "Controller AA:BB:CC:DD:EE:FF Name [default]" format
    MAC=$(echo "$line" | awk '{print $2}')
    if [ -z "$MAC" ]; then
        continue
    fi

    # Query this specific adapter (single bluetoothctl session via stdin)
    INFO=$(ssh "$PI" "echo -e 'select $MAC\nshow $MAC\n' | docker exec -i $CONTAINER bluetoothctl" 2>/dev/null || true)
    DISCOVERABLE=$(echo "$INFO" | grep -i "Discoverable:" | head -1 | awk '{print $2}')

    if [ -z "$DISCOVERABLE" ]; then
        echo "  $MAC: could not read Discoverable property"
        FAIL=true
        continue
    fi

    if [ "$DISCOVERABLE" = "yes" ]; then
        echo "  $MAC: Discoverable=$DISCOVERABLE  FAIL"
        FAIL=true
    else
        echo "  $MAC: Discoverable=$DISCOVERABLE  OK"
    fi
done <<< "$CONTROLLERS"

if [ "$FAIL" = true ]; then
    echo ""
    echo "FAIL: one or more adapters have Discoverable=yes at steady state"
    exit 1
fi
echo "PASS: all adapters have Discoverable=no at steady state"

# Step 2: Specifically verify hci0
echo ""
echo "--- Step 2: hci0 specifically must be Discoverable: no ---"

HCI0_INFO=$(ssh "$PI" "docker exec $CONTAINER hciconfig hci0" 2>/dev/null || true)

if [ -z "$HCI0_INFO" ]; then
    echo "WARN: hci0 not present (may be expected if no onboard adapter)"
else
    echo "$HCI0_INFO"
    # hciconfig shows flags like "UP RUNNING PSCAN ISCAN" where ISCAN = discoverable
    if echo "$HCI0_INFO" | grep -q "ISCAN"; then
        echo "FAIL: hci0 has ISCAN flag (discoverable)"
        exit 1
    fi
    echo "PASS: hci0 does not have ISCAN flag"
fi

echo ""
echo "=== Test: BT silence-by-default PASSED ==="
