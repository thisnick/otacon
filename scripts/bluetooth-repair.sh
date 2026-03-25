#!/bin/bash
# Re-trigger Bluetooth pairing via device owner app + auto-tap pair dialog.
# Runs inside the container. Temporarily clears restrictions if needed.
set -euo pipefail

PI_MAC=$(hciconfig hci0 | grep -oP 'BD Address: \K\S+')
[ -z "$PI_MAC" ] && echo "ERROR: No Bluetooth adapter" && exit 1
echo "Pi BT MAC: $PI_MAC"

# Clear restrictions so BT settings can open
echo "Clearing restrictions..."
adb shell am broadcast -a com.otacon.kiosk.CLEAR_RESTRICTIONS -n com.otacon.kiosk/.BootReceiver > /dev/null
sleep 1

# Start pairing in background
echo "Starting pairing via device owner app..."
PAIR_RESULT=$(mktemp)
(curl -sf -X POST http://127.0.0.1:9090/bluetooth/pair \
    -H 'Content-Type: application/json' \
    -d "{\"mac\": \"$PI_MAC\"}" \
    --max-time 45 > "$PAIR_RESULT" 2>&1 || true) &
PAIR_PID=$!

# Poll snapshot server for "Pair" button and auto-tap it
echo "Watching for pairing dialog..."
for i in $(seq 1 20); do
    sleep 1
    # Check if pairing already finished
    if ! kill -0 $PAIR_PID 2>/dev/null; then
        break
    fi
    # Look for Pair button in a11y tree
    SNAPSHOT=$(curl -sf http://127.0.0.1:9091/snapshot?format=json --max-time 3 2>/dev/null || echo "")
    if [ -z "$SNAPSHOT" ]; then
        continue
    fi
    # Find ref of clickable "Pair" button
    REF=$(echo "$SNAPSHOT" | python3 -c "
import json, sys
def walk(n):
    if n.get('text') == 'Pair' and n.get('clickable'):
        return n.get('ref_id', '')
    for c in n.get('children', []):
        r = walk(c)
        if r: return r
    return ''
data = json.load(sys.stdin)
nodes = data if isinstance(data, list) else [data]
for n in nodes:
    r = walk(n)
    if r:
        print(r)
        break
" 2>/dev/null || echo "")
    if [ -n "$REF" ]; then
        echo "Auto-tapping 'Pair' button ($REF)"
        curl -sf -X POST http://127.0.0.1:9091/action \
            -H 'Content-Type: application/json' \
            -d "{\"action\": \"click\", \"ref\": \"$REF\"}" > /dev/null 2>&1 || true
        break
    fi
done

wait $PAIR_PID 2>/dev/null || true
echo "Pairing result: $(cat "$PAIR_RESULT")"
rm -f "$PAIR_RESULT"

# Reapply restrictions
echo "Reapplying restrictions..."
adb shell am broadcast -a com.otacon.kiosk.APPLY_RESTRICTIONS -n com.otacon.kiosk/.BootReceiver > /dev/null
echo "Done."
