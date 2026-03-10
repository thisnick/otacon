#!/bin/bash
# Remove device owner and uninstall kiosk app.
set -euo pipefail

DEVICE_OWNER_PKG="com.otacon.kiosk"
DEVICE_OWNER_RECEIVER="${DEVICE_OWNER_PKG}/.DeviceOwnerReceiver"

echo "=== Otacon Phone Reset ==="

if ! adb devices | grep -q 'device$'; then
    echo "ERROR: No ADB device found."
    exit 1
fi

SERIAL=$(adb devices | grep 'device$' | head -1 | awk '{print $1}')
echo "Device: ${SERIAL}"

echo "Clearing all user restrictions..."
adb -s "${SERIAL}" shell am broadcast \
    -a com.otacon.kiosk.CLEAR_RESTRICTIONS \
    -n "${DEVICE_OWNER_PKG}/.BootReceiver"

echo "Removing device owner..."
adb -s "${SERIAL}" shell dpm remove-active-admin "${DEVICE_OWNER_RECEIVER}"

echo "Uninstalling app..."
adb -s "${SERIAL}" shell pm uninstall "${DEVICE_OWNER_PKG}"

echo "=== Phone reset complete ==="
