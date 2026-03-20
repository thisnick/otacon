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
hw_mode=g
channel=6
wmm_enabled=0
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

    ip link set wlan0 up || true
    ip addr flush dev wlan0 || true
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
