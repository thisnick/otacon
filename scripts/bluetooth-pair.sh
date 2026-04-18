#!/bin/bash
# Pair the connected Android phone with the Pi's Bluetooth adapter.
# Requires: bluetoothctl, adb, bluetooth-agent.py running, ofonod running.
# PA profile activation (headset_head_unit) is handled by bluetooth-agent.py on connect.
#
# Usage: bluetooth-pair.sh [--adapter hciN] [--serial ADB_SERIAL]
#   --adapter hciN    Use a specific BT adapter (default: hci0)
#   --serial SERIAL   Target a specific ADB device by serial number
set -euo pipefail

# Parse arguments
ADAPTER="hci0"
ADB_SERIAL=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --adapter) ADAPTER="$2"; shift 2 ;;
        --serial)  ADB_SERIAL="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

ADAPTER_PATH="/org/bluez/$ADAPTER"
ADB_CMD="adb"
[ -n "$ADB_SERIAL" ] && ADB_CMD="adb -s $ADB_SERIAL"

# Resolve hciN name to MAC address for bluetoothctl
ADAPTER_MAC=$(hciconfig "$ADAPTER" 2>/dev/null | grep "BD Address" | awk '{print $3}' || true)
if [ -z "$ADAPTER_MAC" ]; then echo "ERROR: Could not find adapter $ADAPTER"; exit 1; fi

echo "=== Bluetooth Pair ==="
echo "Adapter: $ADAPTER ($ADAPTER_MAC)  ADB serial: ${ADB_SERIAL:-<default>}"

# Helper: run bluetoothctl commands on the assigned adapter.
# Each bluetoothctl invocation is a separate process, so 'select' must
# be sent at the start of every session.
btctl() {
    printf 'select %s\n%s\n' "$ADAPTER_MAC" "$*" | bluetoothctl 2>/dev/null
}

# 0. Wait for bluetoothd
echo "Waiting for bluetoothd..."
for i in $(seq 1 30); do
    bluetoothctl show "$ADAPTER_MAC" 2>/dev/null | grep -q "Controller" && break
    sleep 1
done

# Select adapter and power on
btctl power on
sleep 1
btctl discoverable on

PI_BT_MAC="$ADAPTER_MAC"
echo "Pi BT MAC ($ADAPTER): $PI_BT_MAC"

# 1. Enable Bluetooth on phone
echo "Enabling Bluetooth on phone..."
$ADB_CMD shell cmd bluetooth_manager enable 2>/dev/null || \
    $ADB_CMD shell svc bluetooth enable 2>/dev/null || \
    echo "WARNING: Could not enable BT via ADB (may already be on)"
sleep 2

# 2. Get phone MAC
PHONE_BT_MAC=$($ADB_CMD shell settings get secure bluetooth_address 2>/dev/null | tr -d '\r')
if [ -z "$PHONE_BT_MAC" ] || [ "$PHONE_BT_MAC" = "null" ]; then
    echo "Could not get phone BT MAC from settings"
    exit 1
fi
echo "Phone BT MAC: $PHONE_BT_MAC"

# 3. If already paired, test connection (detect stale keys or phone-side unpair)
if btctl info "$PHONE_BT_MAC" | grep -q "Paired: yes"; then
    echo "Already paired — testing connection..."
    btctl trust "$PHONE_BT_MAC"
    CONNECT_OUT=$(btctl connect "$PHONE_BT_MAC" 2>&1 || true)
    if echo "$CONNECT_OUT" | grep -qi "successful\|already connected"; then
        btctl discoverable off
        echo "Connected. bt-agent will activate HFP profile."
        exit 0
    else
        echo "Connection failed (stale or phone-side unpair) — removing device and re-pairing..."
        btctl remove "$PHONE_BT_MAC" || true
        sleep 1
        # fall through to full pair flow
    fi
fi

# 4. Open BT settings on phone (makes it discoverable for BR/EDR)
echo "Opening Bluetooth settings on phone..."
$ADB_CMD shell am start -a android.settings.BLUETOOTH_SETTINGS 2>/dev/null || true
sleep 3

# 5. D-Bus discovery to populate BlueZ device cache
echo "Running discovery on $ADAPTER..."
python3 - "$PHONE_BT_MAC" "$ADAPTER_PATH" <<'PYEOF'
import dbus, sys, time
bus = dbus.SystemBus()
adapter_path = sys.argv[2] if len(sys.argv) > 2 else '/org/bluez/hci0'
adapter = dbus.Interface(bus.get_object('org.bluez', adapter_path), 'org.bluez.Adapter1')
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
btctl pair "$PHONE_BT_MAC" || true
sleep 1

echo "Trusting $PHONE_BT_MAC..."
btctl trust "$PHONE_BT_MAC"
sleep 1

echo "Connecting to $PHONE_BT_MAC..."
btctl connect "$PHONE_BT_MAC" || true

btctl discoverable off
echo "Pair complete. bt-agent will activate headset_head_unit profile."
