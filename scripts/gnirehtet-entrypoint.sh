#!/bin/bash
set -e

# Wait for ADB device
echo "Waiting for ADB device..."
while ! adb devices | grep -q 'device$'; do
    sleep 2
done

# Install gnirehtet APK if not already installed
if ! adb shell pm list packages | grep -q com.genymobile.gnirehtet; then
    echo "Installing gnirehtet APK..."
    adb install -r /usr/local/share/gnirehtet.apk
fi

echo "Starting gnirehtet with DNS: ${GNIREHTET_DNS}"
exec gnirehtet run -d "${GNIREHTET_DNS}"
