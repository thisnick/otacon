#!/bin/bash
# Lightweight BT connect + PA routing — runs on every container start.
# Connects to the first already-paired device and wires up PulseAudio.
# For first-time pairing, run bluetooth-pair.sh instead.
set -euo pipefail

echo "=== Bluetooth Connect ==="

# Wait for bluetoothd
echo "Waiting for bluetoothd..."
for i in $(seq 1 30); do
    bluetoothctl show 2>/dev/null | grep -q "Controller" && break
    sleep 1
done

# Wait for PulseAudio
echo "Waiting for PulseAudio..."
for i in $(seq 1 30); do
    pactl info 2>/dev/null | grep -q "Server Name" && break
    sleep 1
done

# Power on adapter
bluetoothctl power on 2>/dev/null || true
sleep 1

# Get first paired device (filter to only paired ones)
PHONE_MAC=$(bluetoothctl devices 2>/dev/null \
    | awk '{print $2}' \
    | while read mac; do
        bluetoothctl info "$mac" 2>/dev/null | grep -q "Paired: yes" && echo "$mac" && break
    done)
if [ -z "$PHONE_MAC" ]; then
    echo "No paired devices found. Run bluetooth-pair.sh first."
    exit 0
fi

NAME=$(bluetoothctl info "$PHONE_MAC" 2>/dev/null | grep "Name:" | head -1 | awk '{print $2}')
echo "Connecting to $NAME ($PHONE_MAC)..."
bluetoothctl connect "$PHONE_MAC" 2>/dev/null || true
sleep 2

# Activate headset_audio_gateway profile in PulseAudio
MAC_NODOT=$(echo "$PHONE_MAC" | tr ':' '_')
CARD="bluez_card.${MAC_NODOT}"

echo "Waiting for PA card..."
for i in $(seq 1 15); do
    pactl list cards short 2>/dev/null | grep -q "$CARD" && break
    sleep 2
done

if ! pactl list cards short 2>/dev/null | grep -q "$CARD"; then
    echo "WARNING: BT card not found in PulseAudio after 30s — phone may not be in range"
    exit 0
fi

# Set profile
echo "Setting headset_audio_gateway profile..."
pactl set-card-profile "$CARD" headset_audio_gateway 2>/dev/null || \
    pactl set-card-profile "$CARD" a2dp_source 2>/dev/null || true
sleep 2

# Set explicit source/sink so parecord never lands on a monitor
PA_SOURCE=$(pactl list sources short 2>/dev/null \
    | grep "bluez_source.${MAC_NODOT}" | grep -v monitor \
    | awk '{print $2}' | head -1 || true)
PA_SINK=$(pactl list sinks short 2>/dev/null \
    | grep "bluez_sink.${MAC_NODOT}" \
    | awk '{print $2}' | head -1 || true)

if [ -n "$PA_SOURCE" ]; then
    echo "BT source: $PA_SOURCE"
    pactl set-default-source "$PA_SOURCE"
fi
if [ -n "$PA_SINK" ]; then
    echo "BT sink: $PA_SINK"
    pactl set-default-sink "$PA_SINK"
fi

# Restart parecord so it connects to the new default source
ps aux 2>/dev/null | grep '[p]arecord' | awk '{print $2}' | xargs kill 2>/dev/null || true
ps aux 2>/dev/null | grep '[p]aplay'   | awk '{print $2}' | xargs kill 2>/dev/null || true

echo "Bluetooth connect complete"
