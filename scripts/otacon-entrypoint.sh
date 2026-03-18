#!/bin/bash
set -e

# Set up VNC password
if [ -n "${VNC_PASSWORD}" ]; then
    echo "${VNC_PASSWORD}" | vncpasswd -f > /tmp/vncpasswd
    chmod 600 /tmp/vncpasswd
else
    echo "WARNING: VNC_PASSWORD not set, VNC login will fail"
    vncpasswd -f <<< "" > /tmp/vncpasswd
fi

# Wait for ADB device
echo "Waiting for ADB device..."
while ! adb devices 2>/dev/null | grep -q 'device$'; do
    sleep 2
done
SERIAL=$(adb devices | grep 'device$' | head -1 | awk '{print $1}')
echo "Found device: ${SERIAL}"

# Detect phone resolution and calculate display size
PHONE_RES=$(adb shell wm size | grep -oP '\d+x\d+' | tail -1)
PHONE_W=$(echo "$PHONE_RES" | cut -dx -f1)
PHONE_H=$(echo "$PHONE_RES" | cut -dx -f2)
echo "Phone resolution: ${PHONE_W}x${PHONE_H}"

# Scale down by SCRCPY_MAX_SIZE (limits the larger dimension)
if [ "$PHONE_H" -ge "$PHONE_W" ]; then
    SCALE=$(echo "scale=6; ${SCRCPY_MAX_SIZE} / ${PHONE_H}" | bc)
else
    SCALE=$(echo "scale=6; ${SCRCPY_MAX_SIZE} / ${PHONE_W}" | bc)
fi
DISPLAY_W=$(echo "${PHONE_W} * ${SCALE} / 1" | bc)
DISPLAY_H=$(echo "${PHONE_H} * ${SCALE} / 1" | bc)

# Make dimensions even (required by some encoders)
DISPLAY_W=$(( DISPLAY_W / 2 * 2 ))
DISPLAY_H=$(( DISPLAY_H / 2 * 2 ))

export DISPLAY_W
export DISPLAY_H
export DISPLAY_RESOLUTION="${DISPLAY_W}x${DISPLAY_H}"
export DISPLAY=:${DISPLAY_NUM}
echo "Display resolution: ${DISPLAY_RESOLUTION}"

# Install gnirehtet APK if not already installed
if ! adb shell pm list packages | grep -q com.genymobile.gnirehtet; then
    echo "Installing gnirehtet APK..."
    adb install -r /usr/local/share/gnirehtet.apk
fi

# Start supervisord (manages Xvnc, scrcpy, gnirehtet, audio-server)
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/otacon.conf
