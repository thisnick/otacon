#!/bin/bash
# Reconnect to a paired Bluetooth device.
# Pairing is handled by bluetooth-pair.sh; BlueALSA handles audio routing automatically.
#
# Usage: bluetooth-connect.sh [--adapter hciN] [--mac XX:XX:XX:XX:XX:XX] [--serial ADB_SERIAL]
#   --adapter hciN           Use a specific BT adapter (default: first available)
#   --mac XX:XX:XX:XX:XX:XX  Connect a specific phone by BT MAC (default: first paired device)
#   --serial SERIAL          Target a specific ADB device by serial number
set -euo pipefail

# Parse arguments
ADAPTER=""
TARGET_MAC=""
ADB_SERIAL=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --adapter) ADAPTER="$2"; shift 2 ;;
        --mac)     TARGET_MAC="$2"; shift 2 ;;
        --serial)  ADB_SERIAL="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

ADB_CMD="adb"
[ -n "$ADB_SERIAL" ] && ADB_CMD="adb -s $ADB_SERIAL"

echo "=== Bluetooth Connect ==="

# Resolve hciN name to MAC address for bluetoothctl
ADAPTER_MAC=""
if [ -n "$ADAPTER" ]; then
    ADAPTER_MAC=$(hciconfig "$ADAPTER" 2>/dev/null | grep "BD Address" | awk '{print $3}' || true)
    if [ -z "$ADAPTER_MAC" ]; then echo "ERROR: Could not find adapter $ADAPTER"; exit 1; fi
fi

echo "Adapter: ${ADAPTER:-<default>} (${ADAPTER_MAC:-auto})  MAC: ${TARGET_MAC:-<auto>}  ADB serial: ${ADB_SERIAL:-<default>}"

echo "Waiting for bluetoothd..."
SHOW_ARG="${ADAPTER_MAC:-}"
for i in $(seq 1 30); do
    bluetoothctl show $SHOW_ARG 2>/dev/null | grep -q "Controller" && break
    sleep 1
done

# Select adapter if specified
if [ -n "$ADAPTER_MAC" ]; then
    bluetoothctl select "$ADAPTER_MAC" 2>/dev/null || true
fi
bluetoothctl power on 2>/dev/null || true

if [ -n "$TARGET_MAC" ]; then
    # Use the specified MAC directly
    PHONE_MAC="$TARGET_MAC"
    # Verify it's a known device
    if ! bluetoothctl info "$PHONE_MAC" 2>/dev/null | grep -q "Device"; then
        echo "ERROR: Device $PHONE_MAC not found. Run bluetooth-pair.sh first."
        exit 1
    fi
else
    # Find the first paired device (original behavior)
    PHONE_MAC=$(bluetoothctl devices 2>/dev/null \
        | awk '{print $2}' \
        | while read -r mac; do
            bluetoothctl info "$mac" 2>/dev/null | grep -q "Paired: yes" && echo "$mac" && break
        done)
fi

if [ -z "$PHONE_MAC" ]; then
    echo "No paired devices found. Run bluetooth-pair.sh first."
    exit 0
fi

NAME=$(bluetoothctl info "$PHONE_MAC" 2>/dev/null | grep "Name:" | head -1 | awk '{print $2}')
echo "Connecting to $NAME ($PHONE_MAC)..."
bluetoothctl connect "$PHONE_MAC" 2>/dev/null || true

# Set phone media volume to max
MAX_VOL=$($ADB_CMD shell media volume --stream 3 2>/dev/null | grep -oP '(?<=max: )\d+' || echo "")
if [ -n "$MAX_VOL" ]; then
    $ADB_CMD shell media volume --stream 3 --set "$MAX_VOL" 2>/dev/null && echo "Media volume set to max ($MAX_VOL)" || true
fi

echo "Done."
