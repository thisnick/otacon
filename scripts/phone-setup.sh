#!/bin/bash
# Set up Android phone as a locked kiosk device.
# Prerequisites: phone must have no Google accounts, USB debugging enabled.
set -euo pipefail

DEVICE_OWNER_PKG="com.otacon.kiosk"
DEVICE_OWNER_RECEIVER="${DEVICE_OWNER_PKG}/.DeviceOwnerReceiver"
APK_PATH="${1:-}"

echo "=== Otacon Phone Setup ==="

# Check ADB connection
if ! adb devices | grep -q 'device$'; then
    echo "ERROR: No ADB device found. Connect phone and enable USB debugging."
    exit 1
fi

SERIAL=$(adb devices | grep 'device$' | head -1 | awk '{print $1}')
echo "Device: ${SERIAL}"

# Check for Google accounts (device owner requires none)
ACCOUNTS=$(adb -s "${SERIAL}" shell dumpsys account 2>/dev/null | grep -c 'Account {' || true)
if [ "${ACCOUNTS}" -gt 0 ]; then
    echo "ERROR: Device has ${ACCOUNTS} account(s). Remove all accounts before setting device owner."
    echo "  Settings → Accounts → Remove each account"
    exit 1
fi

# Find APK
if [ -z "${APK_PATH}" ]; then
    # Try to find APK locally
    APK_PATH=$(find . -name "*.apk" -path "*/device-owner/*" 2>/dev/null | head -1)
fi
if [ -z "${APK_PATH}" ] || [ ! -f "${APK_PATH}" ]; then
    echo "ERROR: Device Owner APK not found."
    echo "  Provide path: $0 /path/to/device-owner.apk"
    echo "  Or build: cd android/device-owner && ./gradlew assembleRelease"
    exit 1
fi

echo "Installing APK: ${APK_PATH}"
adb -s "${SERIAL}" install -r "${APK_PATH}"

echo "Setting device owner..."
adb -s "${SERIAL}" shell dpm set-device-owner "${DEVICE_OWNER_RECEIVER}"

echo "Triggering initial policy apply..."
adb -s "${SERIAL}" shell am broadcast \
    -a android.intent.action.BOOT_COMPLETED \
    -n "${DEVICE_OWNER_PKG}/.BootReceiver"

echo ""
echo "=== Phone setup complete ==="
echo "Restrictions applied. Phone is now a locked kiosk."
echo "To undo: make phone-reset"
