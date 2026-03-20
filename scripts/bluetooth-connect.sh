#!/bin/bash
# Reconnect to the first already-paired Bluetooth device.
# Pairing is handled by bluetooth-pair.sh; BlueALSA handles audio routing automatically.
set -euo pipefail

echo "=== Bluetooth Connect ==="

echo "Waiting for bluetoothd..."
for i in $(seq 1 30); do
    bluetoothctl show 2>/dev/null | grep -q "Controller" && break
    sleep 1
done

bluetoothctl power on 2>/dev/null || true

PHONE_MAC=$(bluetoothctl devices 2>/dev/null \
    | awk '{print $2}' \
    | while read -r mac; do
        bluetoothctl info "$mac" 2>/dev/null | grep -q "Paired: yes" && echo "$mac" && break
    done)

if [ -z "$PHONE_MAC" ]; then
    echo "No paired devices found. Run bluetooth-pair.sh first."
    exit 0
fi

NAME=$(bluetoothctl info "$PHONE_MAC" 2>/dev/null | grep "Name:" | head -1 | awk '{print $2}')
echo "Connecting to $NAME ($PHONE_MAC)..."
bluetoothctl connect "$PHONE_MAC" 2>/dev/null || true

# Set phone media volume to max
MAX_VOL=$(adb shell media volume --stream 3 2>/dev/null | grep -oP '(?<=max: )\d+' || echo "")
if [ -n "$MAX_VOL" ]; then
    adb shell media volume --stream 3 --set "$MAX_VOL" 2>/dev/null && echo "Media volume set to max ($MAX_VOL)" || true
fi

echo "Done."
