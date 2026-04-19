#!/bin/bash
# wifi-monitor.sh — Ensures the WiFi AP stays up.
# Checks every 30s that brcmfmac is loaded, wlan0 exists,
# hostapd/dnsmasq are running, and the IP is correct.
# Runs inside the privileged otacon container with host networking.

TAG="wifi-monitor"
log() { echo "$(date +%H:%M:%S) ${TAG}: $*"; }

[ -z "${WIFI_AP_SSID:-}" ] && { log "WIFI_AP_SSID not set, exiting"; sleep infinity; }

EXPECTED_IP="10.42.0.1/24"

while true; do
    FIXED=false

    # 1. Ensure brcmfmac kernel module is loaded
    if ! ip link show wlan0 &>/dev/null; then
        log "wlan0 missing — loading brcmfmac"
        modprobe brcmfmac 2>/dev/null || true
        sleep 3
        if ! ip link show wlan0 &>/dev/null; then
            log "wlan0 still missing after modprobe — retrying in 30s"
            sleep 30
            continue
        fi
        FIXED=true
    fi

    # 2. Ensure wlan0 is up with correct IP
    if ! ip addr show wlan0 | grep -q "$EXPECTED_IP"; then
        log "wlan0 IP missing — configuring"
        ip link set wlan0 down 2>/dev/null || true
        ip addr flush dev wlan0 2>/dev/null || true
        ip link set wlan0 up 2>/dev/null || true
        ip addr add "$EXPECTED_IP" dev wlan0 2>/dev/null || true
        FIXED=true
    fi

    # 3. Ensure hostapd is running (supervisord handles restart,
    #    but if wlan0 was gone it may have given up)
    if ! pgrep -x hostapd &>/dev/null; then
        log "hostapd not running — restarting via supervisord"
        supervisorctl restart hostapd 2>/dev/null || true
        sleep 2
        FIXED=true
    fi

    # 4. Ensure dnsmasq is running and bound to wlan0
    if ! pgrep -x dnsmasq &>/dev/null; then
        log "dnsmasq not running — restarting via supervisord"
        supervisorctl restart dnsmasq 2>/dev/null || true
        sleep 2
        FIXED=true
    fi

    # 5. Ensure iptables NAT + OTACON_FWD chain are set up
    if ! iptables -t nat -S POSTROUTING 2>/dev/null | grep -q -- "-s 10.42.0.0/24"; then
        log "iptables NAT missing — reconfiguring"
        sysctl -w net.ipv4.ip_forward=1 &>/dev/null
        iptables -t nat -A POSTROUTING -s 10.42.0.0/24 -o eth0 -j MASQUERADE 2>/dev/null || true
        FIXED=true
    fi
    if ! iptables -t nat -S POSTROUTING 2>/dev/null | grep -q -- "-s 172.0.0.0/8"; then
        log "Docker bridge NAT missing — adding"
        iptables -t nat -A POSTROUTING -s 172.0.0.0/8 -o eth0 -j MASQUERADE 2>/dev/null || true
        FIXED=true
    fi
    # Ensure OTACON_FWD chain exists and is jumped to from FORWARD
    if ! iptables -L OTACON_FWD -n 2>/dev/null | grep -q "OTACON_FWD"; then
        log "OTACON_FWD chain missing — rebuilding"
        iptables -N OTACON_FWD 2>/dev/null || iptables -F OTACON_FWD
        iptables -C FORWARD -j OTACON_FWD 2>/dev/null || iptables -I FORWARD 1 -j OTACON_FWD
        iptables -A OTACON_FWD -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
        iptables -A OTACON_FWD -i wlan0 -o eth0 -s 10.42.0.0/24 -j ACCEPT 2>/dev/null || true
        iptables -A OTACON_FWD -i br-+ -o eth0 -j ACCEPT 2>/dev/null || true
        iptables -A OTACON_FWD -i eth0 -o br-+ -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
        iptables -A OTACON_FWD -o br-+ -m conntrack --ctstate DNAT -j ACCEPT 2>/dev/null || true
        iptables -A OTACON_FWD -i wlan0 -d 10.0.0.0/8 -j DROP 2>/dev/null || true
        iptables -A OTACON_FWD -i wlan0 -d 172.16.0.0/12 -j DROP 2>/dev/null || true
        iptables -A OTACON_FWD -i wlan0 -d 192.168.0.0/16 -j DROP 2>/dev/null || true
        iptables -A OTACON_FWD -i wlan0 -j DROP 2>/dev/null || true
        FIXED=true
    fi

    if [ "$FIXED" = true ]; then
        log "AP recovered"
    fi

    sleep 30
done
