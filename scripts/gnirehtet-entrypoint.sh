#!/bin/bash
set -e

# Wait for ADB device
echo "Waiting for ADB device..."
while ! /usr/bin/adb devices | grep -q 'device$'; do
    sleep 2
done

# Install gnirehtet APK if not already installed
if ! /usr/bin/adb shell pm list packages | grep -q com.genymobile.gnirehtet; then
    echo "Installing gnirehtet APK..."
    /usr/bin/adb install -r /usr/local/share/gnirehtet.apk
fi

echo "Starting gnirehtet with DNS: ${GNIREHTET_DNS}"
exec gnirehtet run -d "${GNIREHTET_DNS}"
