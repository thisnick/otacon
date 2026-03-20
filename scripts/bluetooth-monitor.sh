#!/bin/bash
# Watches for phone connected-but-HFP-profile-off and auto-activates.
# Runs continuously under supervisord.
sleep 15

while true; do
    for mac in $(bluetoothctl devices 2>/dev/null | awk '{print $2}'); do
        if bluetoothctl info "$mac" 2>/dev/null | grep -q "Connected: yes"; then
            mac_nodot=$(echo "$mac" | tr ':' '_')
            card="bluez_card.${mac_nodot}"
            if pactl list cards short 2>/dev/null | grep -q "$card"; then
                profile=$(pactl list cards 2>/dev/null \
                    | grep -A30 "Name: $card" \
                    | grep "Active Profile:" \
                    | awk '{print $3}')
                if [ "$profile" = "off" ]; then
                    echo "bt-monitor: $mac profile=off, activating HFP..."
                    /opt/bluetooth-connect.sh
                fi
            fi
        fi
    done
    sleep 10
done
