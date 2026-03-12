#!/bin/bash
set -e

export DISPLAY=:${DISPLAY_NUM}

# Wait for ADB device
echo "Waiting for ADB device..."
while ! /usr/bin/adb devices | grep -q 'device$'; do
    sleep 2
done
SERIAL=$(/usr/bin/adb devices | grep 'device$' | head -1 | awk '{print $1}')
echo "Found device: ${SERIAL}"

# Start supervisord (manages Xvfb, scrcpy, x11vnc)
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/phone-mirror.conf
