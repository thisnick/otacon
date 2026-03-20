#!/bin/bash
# Pair the connected Android phone with the Pi's Bluetooth adapter.
# Requires: bluetoothctl, adb, bluetooth-agent.py running, ofonod running.
# PA profile activation (headset_head_unit) is handled by bluetooth-agent.py on connect.
set -euo pipefail

echo "=== Bluetooth Pair ==="

# 0. Wait for bluetoothd
echo "Waiting for bluetoothd..."
for i in $(seq 1 30); do
    bluetoothctl show 2>/dev/null | grep -q "Controller" && break
    sleep 1
done

bluetoothctl power on
sleep 1

PI_BT_MAC=$(bluetoothctl show | grep "Controller" | awk '{print $2}')
[ -z "$PI_BT_MAC" ] && echo "ERROR: No Bluetooth adapter" && exit 1
echo "Pi BT MAC: $PI_BT_MAC"

# 1. Enable Bluetooth on phone
echo "Enabling Bluetooth on phone..."
adb shell cmd bluetooth_manager enable 2>/dev/null || \
    adb shell svc bluetooth enable 2>/dev/null || \
    echo "WARNING: Could not enable BT via ADB (may already be on)"
sleep 2

# 2. Get phone MAC
PHONE_BT_MAC=$(adb shell settings get secure bluetooth_address 2>/dev/null | tr -d '\r')
if [ -z "$PHONE_BT_MAC" ] || [ "$PHONE_BT_MAC" = "null" ]; then
    echo "Could not get phone BT MAC from settings"
    exit 1
fi
echo "Phone BT MAC: $PHONE_BT_MAC"

# 3. If already paired, test connection (detect stale keys)
if bluetoothctl info "$PHONE_BT_MAC" 2>/dev/null | grep -q "Paired: yes"; then
    echo "Already paired — testing connection..."
    bluetoothctl trust "$PHONE_BT_MAC"
    CONNECT_OUT=$(bluetoothctl connect "$PHONE_BT_MAC" 2>&1 || true)
    if echo "$CONNECT_OUT" | grep -q "br-connection-key-missing"; then
        echo "Stale keys — removing device and re-pairing..."
        bluetoothctl remove "$PHONE_BT_MAC" 2>/dev/null || true
        sleep 1
        # fall through to full pair flow
    else
        echo "Connected. bt-agent will activate HFP profile."
        exit 0
    fi
fi

# 4. Open BT settings on phone (makes it discoverable for BR/EDR)
echo "Opening Bluetooth settings on phone..."
adb shell am start -a android.settings.BLUETOOTH_SETTINGS 2>/dev/null || true
sleep 3

# 5. D-Bus discovery to populate BlueZ device cache
echo "Running discovery..."
python3 - "$PHONE_BT_MAC" <<'PYEOF'
import dbus, sys, time
bus = dbus.SystemBus()
adapter = dbus.Interface(bus.get_object('org.bluez', '/org/bluez/hci0'), 'org.bluez.Adapter1')
target = sys.argv[1] if len(sys.argv) > 1 else ""
adapter.StartDiscovery()
for _ in range(15):
    time.sleep(1)
    mgr = dbus.Interface(bus.get_object('org.bluez', '/'), 'org.freedesktop.DBus.ObjectManager')
    for path, ifaces in mgr.GetManagedObjects().items():
        if 'org.bluez.Device1' in ifaces:
            addr = str(ifaces['org.bluez.Device1'].get('Address', ''))
            if addr.upper() == target.upper():
                print(f"Found {addr}")
                adapter.StopDiscovery()
                sys.exit(0)
adapter.StopDiscovery()
print("Discovery complete (device not found in cache)")
PYEOF

# 6. Pair, trust, connect
# NOTE: Tap "Pair" on the phone when the dialog appears.
echo "Pairing with $PHONE_BT_MAC... (tap Pair on phone when prompted)"
bluetoothctl pair "$PHONE_BT_MAC" || true
sleep 1

echo "Trusting $PHONE_BT_MAC..."
bluetoothctl trust "$PHONE_BT_MAC"
sleep 1

echo "Connecting to $PHONE_BT_MAC..."
bluetoothctl connect "$PHONE_BT_MAC" || true

echo "Pair complete. bt-agent will activate headset_head_unit profile."
