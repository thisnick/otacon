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

# Auto-detect phone Bluetooth MAC from ADB and set BLUEALSA_DEVICE
if [ "$AUDIO_BACKEND" = "bluetooth" ]; then
    PHONE_BT_MAC=$(adb shell settings get secure bluetooth_address 2>/dev/null | tr -d '\r')
    if [ -n "$PHONE_BT_MAC" ] && [ "$PHONE_BT_MAC" != "null" ]; then
        export BLUEALSA_DEVICE="bluealsa:DEV=${PHONE_BT_MAC},PROFILE=sco"
        echo "BLUEALSA_DEVICE auto-detected: $BLUEALSA_DEVICE"
    else
        echo "WARNING: Could not detect phone BT MAC via ADB"
    fi
fi

# === Device Owner auto-provisioning ===
if ! adb shell dpm list-owners 2>/dev/null | grep -q "com.otacon.kiosk"; then
    echo "Device owner not set — provisioning..."
    # Check for Google accounts (device owner requires none)
    ACCOUNT_COUNT=$(adb shell dumpsys account 2>/dev/null | grep -c "Account {" || true)
    if [ "${ACCOUNT_COUNT:-0}" -gt 0 ]; then
        echo "ERROR: Phone has $ACCOUNT_COUNT account(s). Factory reset required for device owner."
        echo "Continuing without device owner (reduced functionality)."
    elif [ -f /opt/otacon-kiosk.apk ]; then
        adb install -r /opt/otacon-kiosk.apk
        adb shell dpm set-device-owner com.otacon.kiosk/.DeviceOwnerReceiver
        adb shell am broadcast -a com.otacon.kiosk.APPLY_RESTRICTIONS
        # Enable accessibility service and notification listener
        adb shell settings put secure enabled_accessibility_services \
            com.otacon.kiosk/.OtaconAccessibilityService
        adb shell cmd notification allow_listener \
            com.otacon.kiosk/.OtaconNotificationListener
        echo "Device owner provisioned"
    else
        echo "WARNING: /opt/otacon-kiosk.apk not found — skipping device owner setup"
    fi
else
    echo "Device owner already set"
fi

# Keep screen on and disable lock screen
adb shell settings put system screen_off_timeout 2147483647 || true
adb shell svc power stayon usb || true
adb shell input keyevent 26 || true  # wake screen if off

# Set up ADB port forward to device owner HTTP server
adb forward tcp:9090 tcp:9090 2>/dev/null || true

# Connect phone to Pi's WiFi AP
if [ -n "${WIFI_AP_SSID:-}" ]; then
    echo "Connecting phone to WiFi AP '${WIFI_AP_SSID}'..."
    adb shell cmd wifi connect-network "${WIFI_AP_SSID}" wpa2 "${WIFI_AP_PASSWORD}" || true
fi

# Build supervisor config based on audio backend
cp /etc/supervisor/conf.d/supervisord-base.conf /tmp/supervisord.conf
if [ "$AUDIO_BACKEND" = "bluetooth" ]; then
    echo "Audio backend: Bluetooth HFP (BlueALSA)"
    cat /etc/supervisor/conf.d/supervisord-bluetooth.conf >> /tmp/supervisord.conf
    rfkill unblock bluetooth || true
else
    echo "Audio backend: ALSA (cable)"
fi

# === WiFi AP setup ===
if [ -n "${WIFI_AP_SSID:-}" ]; then
    echo "Setting up WiFi AP: ${WIFI_AP_SSID}"

    cat > /etc/hostapd/hostapd.conf <<EOF
interface=wlan0
driver=nl80211
ssid=${WIFI_AP_SSID}
country_code=US
hw_mode=g
channel=6
ieee80211n=1
wmm_enabled=1
auth_algs=1
wpa=2
wpa_passphrase=${WIFI_AP_PASSWORD}
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
EOF

    cat > /etc/dnsmasq-ap.conf <<EOF
interface=wlan0
bind-interfaces
dhcp-range=10.42.0.100,10.42.0.200,255.255.255.0,12h
dhcp-option=option:router,10.42.0.1
dhcp-option=option:dns-server,10.42.0.1
server=8.8.8.8
server=8.8.4.4
EOF

    # Disconnect from any existing WiFi and take exclusive control of wlan0
    pkill wpa_supplicant || true
    sleep 1
    dhcpcd --release wlan0 2>/dev/null || true
    ip link set wlan0 down || true
    ip addr flush dev wlan0 || true
    ip link set wlan0 up || true
    ip addr add 10.42.0.1/24 dev wlan0 || true

    sysctl -w net.ipv4.ip_forward=1

    iptables -F FORWARD || true
    iptables -t nat -F POSTROUTING || true
    iptables -t nat -A POSTROUTING -s 10.42.0.0/24 -o eth0 -j MASQUERADE
    iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT
    iptables -A FORWARD -i wlan0 -o eth0 -s 10.42.0.0/24 -j ACCEPT
    iptables -A FORWARD -i wlan0 -d 10.0.0.0/8     -j DROP
    iptables -A FORWARD -i wlan0 -d 172.16.0.0/12  -j DROP
    iptables -A FORWARD -i wlan0 -d 192.168.0.0/16 -j DROP
    iptables -A FORWARD -i wlan0 -j DROP
else
    echo "WIFI_AP_SSID not set — skipping WiFi AP setup"
fi

# Start supervisord
exec /usr/bin/supervisord -c /tmp/supervisord.conf
