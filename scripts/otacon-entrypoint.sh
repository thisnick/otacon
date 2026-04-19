#!/bin/bash
set -e

# Set up VNC auth — password if set, otherwise no auth
if [ -n "${VNC_PASSWORD}" ]; then
    echo "${VNC_PASSWORD}" | vncpasswd -f > /tmp/vncpasswd
    chmod 600 /tmp/vncpasswd
    export VNC_AUTH_ARGS="-rfbauth /tmp/vncpasswd"
else
    export VNC_AUTH_ARGS="-SecurityTypes None"
fi

# Display/scrcpy/VNC are spawned per-phone by device-monitor.py.
# No single-phone ADB wait needed here.

# Build supervisor config based on audio backend
cp /etc/supervisor/conf.d/supervisord-base.conf /tmp/supervisord.conf
if [ "$AUDIO_BACKEND" = "bluetooth" ]; then
    echo "Audio backend: Bluetooth HFP (BlueALSA)"
    cat /etc/supervisor/conf.d/supervisord-bluetooth.conf >> /tmp/supervisord.conf
    rfkill unblock bluetooth || true
else
    echo "Audio backend: ALSA (cable)"
fi

# === WiFi AP setup (Pi-side, no phone needed) ===
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
ignore_broadcast_ssid=1
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

    # Use a custom chain for WiFi AP firewall rules so we don't flush Docker's
    # own FORWARD rules (which handle port-mapped container traffic like admin:9090).
    iptables -N OTACON_FWD 2>/dev/null || iptables -F OTACON_FWD
    # Ensure our chain is jumped to from FORWARD (idempotent — check before adding)
    iptables -C FORWARD -j OTACON_FWD 2>/dev/null || iptables -I FORWARD 1 -j OTACON_FWD

    iptables -t nat -F POSTROUTING || true
    iptables -t nat -A POSTROUTING -s 10.42.0.0/24 -o eth0 -j MASQUERADE
    # Docker bridge containers (e.g. tailscale-registry sidecar) need outbound access
    iptables -t nat -A POSTROUTING -s 172.0.0.0/8 -o eth0 -j MASQUERADE

    # WiFi AP: allow phones out to internet, block LAN access
    iptables -A OTACON_FWD -m state --state ESTABLISHED,RELATED -j ACCEPT
    iptables -A OTACON_FWD -i wlan0 -o eth0 -s 10.42.0.0/24 -j ACCEPT
    # Docker bridge outbound (sidecar → internet)
    iptables -A OTACON_FWD -i br-+ -o eth0 -j ACCEPT
    iptables -A OTACON_FWD -i eth0 -o br-+ -m state --state RELATED,ESTABLISHED -j ACCEPT
    # Inbound to Docker bridge containers (e.g. admin:9090 via Tailscale / eth0)
    iptables -A OTACON_FWD -o br-+ -m conntrack --ctstate DNAT -j ACCEPT
    # WiFi AP isolation — block phones from reaching LAN/Docker
    iptables -A OTACON_FWD -i wlan0 -d 10.0.0.0/8     -j DROP
    iptables -A OTACON_FWD -i wlan0 -d 172.16.0.0/12  -j DROP
    iptables -A OTACON_FWD -i wlan0 -d 192.168.0.0/16 -j DROP
    iptables -A OTACON_FWD -i wlan0 -j DROP
else
    echo "WIFI_AP_SSID not set — skipping WiFi AP setup"
fi

# Start supervisord — device-monitor handles provisioning, WiFi connect,
# port forwarding, and reconnection in the background.
exec /usr/bin/supervisord -c /tmp/supervisord.conf
