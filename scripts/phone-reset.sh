#!/bin/bash
# Remove device owner and uninstall kiosk app.
set -euo pipefail

DEVICE_OWNER_PKG="com.otacon.kiosk"

echo "=== Otacon Phone Reset ==="

if ! adb devices | grep -q 'device$'; then
    echo "ERROR: No ADB device found."
    exit 1
fi

SERIAL=$(adb devices | grep 'device$' | head -1 | awk '{print $1}')
echo "Device: ${SERIAL}"

echo "Removing device owner (clears restrictions + revokes ownership)..."
adb -s "${SERIAL}" shell am broadcast \
    -a com.otacon.kiosk.REMOVE_DEVICE_OWNER \
    -n "${DEVICE_OWNER_PKG}/.BootReceiver"

sleep 2

echo "Uninstalling app..."
adb -s "${SERIAL}" shell pm uninstall "${DEVICE_OWNER_PKG}" || true

echo "=== Phone reset complete ==="
echo "You can now factory reset the phone if needed."
