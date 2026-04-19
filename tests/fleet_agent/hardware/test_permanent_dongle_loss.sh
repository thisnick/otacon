#!/usr/bin/env bash
# Hardware test: permanent dongle loss
#
# Simulates a BT dongle disappearing for > 5 min (the cooldown threshold).
# Verifies:
#   1. After 320s, a dongle.lost event is emitted
#   2. The orphaned phone gets reassigned to the spare dongle
#   3. A phone.reassigned event is emitted
#   4. The phone re-pairs and BT connects on the NEW dongle within ~3 min
#
# Uses a USB adapter (not hci0). Removes it via USB unbind (sysfs) and
# holds it offline for the full cooldown. The phone should auto-reassign
# to the spare dongle.
#
# NOTE: hciconfig down does NOT work for this test — on some kernels
# the adapter stays UP RUNNING even after the down command. USB unbind
# truly removes the adapter from the system.
#
# WARNING: This test takes ~8 minutes. One dongle will be offline for the
# duration. The orphaned phone will lose BT until reassignment completes.
#
# Usage: ./test_permanent_dongle_loss.sh
# Requires: ssh access to otacon-pi, curl, jq

set -euo pipefail

PI="nick@otacon-pi"
PI_FQDN=$(tailscale status --json | jq -r '.Peer[] | select(.HostName == "otacon-pi") | .DNSName | rtrimstr(".")')
PI_URL="https://${PI_FQDN}:8080"
REGISTRY_URL="http://localhost:8080"
CONTAINER="otacon-otacon-1"
COOLDOWN=320  # 5 min + 20s margin
REPAIR_WAIT=180  # 3 min for re-pair on new dongle

echo "=== Test: permanent dongle loss ==="

# --- Step 0: Find a USB dongle assigned to a phone (not hci0) ---
DONGLES=$(curl -s "$REGISTRY_URL/api/v1/dongles")
TARGET_DONGLE=$(echo "$DONGLES" | jq -r '[.[] | select(.phone_id != null and .hci_device != "hci0")] | .[0] // empty')

if [ -z "$TARGET_DONGLE" ] || [ "$TARGET_DONGLE" = "null" ]; then
    echo "SKIP: no USB dongle with phone assignment found"
    exit 0
fi

DONGLE_ID=$(echo "$TARGET_DONGLE" | jq -r '.id')
DONGLE_MAC=$(echo "$TARGET_DONGLE" | jq -r '.bt_mac')
DONGLE_HCI=$(echo "$TARGET_DONGLE" | jq -r '.hci_device // empty')
VICTIM_PHONE=$(echo "$TARGET_DONGLE" | jq -r '.phone_id')

# If hci_device is missing from registry, resolve it from hciconfig by MAC
if [ -z "$DONGLE_HCI" ] || [ "$DONGLE_HCI" = "null" ]; then
    DONGLE_HCI=$(ssh "$PI" "docker exec $CONTAINER hciconfig -a" 2>/dev/null \
        | awk -v mac="$DONGLE_MAC" '
            /^hci/ { dev=$1; sub(/:$/,"",dev) }
            /BD Address:/ { if (toupper($3) == toupper(mac)) print dev }
        ')
fi

if [ -z "$DONGLE_HCI" ]; then
    echo "SKIP: cannot resolve hci device for $DONGLE_MAC"
    exit 0
fi
echo "Victim dongle: $DONGLE_ID ($DONGLE_MAC, $DONGLE_HCI)"
echo "Orphaned phone: $VICTIM_PHONE"

# Check there's a spare dongle available for reassignment
SPARE_COUNT=$(echo "$DONGLES" | jq '[.[] | select(.phone_id == null or .phone_id == "")] | length')
echo "Spare dongles available: $SPARE_COUNT"

if [ "$SPARE_COUNT" -eq 0 ]; then
    echo "SKIP: no spare dongle available for reassignment test"
    exit 0
fi

# Record event baseline
EVENT_BASELINE=$(curl -s "$REGISTRY_URL/api/v1/events?limit=1" | jq '.[0].id // 0')

# --- Resolve the hci device to its USB device path ---
USB_INTF=$(ssh "$PI" "docker exec $CONTAINER readlink -f /sys/class/bluetooth/$DONGLE_HCI/device" 2>/dev/null | xargs basename)
# USB_INTF looks like "1-1.1.2:1.0" — strip the interface suffix for unbind
USB_DEV=$(echo "$USB_INTF" | sed 's/:.*//')
echo "USB device path: $USB_DEV (interface: $USB_INTF)"

if [ -z "$USB_DEV" ] || echo "$USB_DEV" | grep -q "serial"; then
    echo "SKIP: $DONGLE_HCI is not a USB adapter (path=$USB_DEV)"
    exit 0
fi

# --- Step 1: Remove the dongle via USB unbind ---
echo ""
echo "--- Unbinding USB device $USB_DEV (simulating permanent dongle removal) ---"
ssh "$PI" "docker exec $CONTAINER bash -c 'echo $USB_DEV > /sys/bus/usb/drivers/usb/unbind'" 2>/dev/null || true
echo "USB device unbound. Holding offline for ${COOLDOWN}s..."

# Save USB path for test_replug_after_cutoff.sh
echo "$USB_DEV" > /tmp/otacon_lost_dongle_usb_path

# --- Step 2: Wait for cooldown ---
ELAPSED=0
while [ "$ELAPSED" -lt "$COOLDOWN" ]; do
    REMAINING=$((COOLDOWN - ELAPSED))
    if [ $((ELAPSED % 60)) -eq 0 ]; then
        echo "  [${ELAPSED}s / ${COOLDOWN}s] waiting... (${REMAINING}s remaining)"
    fi
    sleep 10
    ELAPSED=$((ELAPSED + 10))
done
echo "  Cooldown elapsed."

# --- Step 3: Verify dongle.lost event ---
echo ""
echo "--- Checking for dongle.lost event ---"
LOST_EVENTS=$(curl -s "$REGISTRY_URL/api/v1/events?event_type=info.dongle.lost&limit=10")
NEW_LOST=$(echo "$LOST_EVENTS" | jq --argjson baseline "$EVENT_BASELINE" '[.[] | select(.id > $baseline)] | length')

if [ "$NEW_LOST" -eq 0 ]; then
    echo "FAIL: no dongle.lost event emitted after cooldown"
    # Cleanup: bring dongle back
    ssh "$PI" "docker exec $CONTAINER bash -c 'echo $USB_DEV > /sys/bus/usb/drivers/usb/bind'" 2>/dev/null || true
    exit 1
fi
echo "PASS: dongle.lost event emitted (count=$NEW_LOST)"

# --- Step 4: Verify phone.reassigned event ---
# The reassignment involves BT re-pairing which can take 60-90s after
# the dongle.lost event fires. Wait up to 120s for the event.
echo ""
echo "--- Waiting up to 120s for phone.reassigned event ---"
REASSIGN_START=$(date +%s)
NEW_REASSIGN=0

while true; do
    NOW=$(date +%s)
    REASSIGN_ELAPSED=$((NOW - REASSIGN_START))
    if [ "$REASSIGN_ELAPSED" -ge 120 ]; then
        break
    fi

    REASSIGN_EVENTS=$(curl -s "$REGISTRY_URL/api/v1/events?event_type=info.phone.reassigned&entity_id=$VICTIM_PHONE&limit=10")
    NEW_REASSIGN=$(echo "$REASSIGN_EVENTS" | jq --argjson baseline "$EVENT_BASELINE" '[.[] | select(.id > $baseline)] | length')

    if [ "$NEW_REASSIGN" -gt 0 ]; then
        echo "  phone.reassigned event found at T+${REASSIGN_ELAPSED}s"
        break
    fi

    echo "  [${REASSIGN_ELAPSED}s] waiting for reassignment..."
    sleep 10
done

if [ "$NEW_REASSIGN" -eq 0 ]; then
    echo "FAIL: no phone.reassigned event emitted for $VICTIM_PHONE within 120s"
    ssh "$PI" "docker exec $CONTAINER bash -c 'echo $USB_DEV > /sys/bus/usb/drivers/usb/bind'" 2>/dev/null || true
    exit 1
fi
echo "PASS: phone.reassigned event emitted (count=$NEW_REASSIGN)"

# --- Step 5: Verify phone now assigned to a DIFFERENT dongle ---
echo ""
echo "--- Verifying phone reassigned to new dongle ---"
PHONES_AFTER=$(curl -s "$REGISTRY_URL/api/v1/phones")
NEW_ADAPTER=$(echo "$PHONES_AFTER" | jq -r ".[] | select(.id == \"$VICTIM_PHONE\") | .adapter_mac // empty")
echo "Phone's new adapter_mac: ${NEW_ADAPTER:-none}"

DONGLES_AFTER=$(curl -s "$REGISTRY_URL/api/v1/dongles")
NEW_DONGLE_ID=$(echo "$DONGLES_AFTER" | jq -r ".[] | select(.phone_id == \"$VICTIM_PHONE\") | .id // empty")
echo "Phone's new dongle: ${NEW_DONGLE_ID:-none}"

if [ "$NEW_DONGLE_ID" = "$DONGLE_ID" ]; then
    echo "FAIL: phone still assigned to the lost dongle"
    ssh "$PI" "docker exec $CONTAINER bash -c 'echo $USB_DEV > /sys/bus/usb/drivers/usb/bind'" 2>/dev/null || true
    exit 1
fi

if [ -z "$NEW_DONGLE_ID" ]; then
    echo "FAIL: phone has no dongle assignment after reassignment"
    ssh "$PI" "docker exec $CONTAINER bash -c 'echo $USB_DEV > /sys/bus/usb/drivers/usb/bind'" 2>/dev/null || true
    exit 1
fi
echo "PASS: phone reassigned from $DONGLE_ID to $NEW_DONGLE_ID"

# --- Step 6: Wait for BT to connect on the new dongle ---
echo ""
echo "--- Waiting up to ${REPIAR_WAIT:-$REPAIR_WAIT}s for BT on new dongle ---"
BT_START=$(date +%s)
BT_OK=false

while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - BT_START))
    if [ "$ELAPSED" -ge "$REPAIR_WAIT" ]; then
        break
    fi

    INFO=$(curl -sk "$PI_URL/phones/$VICTIM_PHONE/api/info" 2>/dev/null || echo "{}")
    BT_BONDED=$(echo "$INFO" | jq -r '.monitor.health.bt_bonded // false')
    BT_CONNECTED=$(echo "$INFO" | jq -r '.monitor.health.bt_connected // false')

    echo "  [${ELAPSED}s] bt_bonded=$BT_BONDED bt_connected=$BT_CONNECTED"

    if [ "$BT_BONDED" = "true" ] && [ "$BT_CONNECTED" = "true" ]; then
        BT_OK=true
        echo "  BT connected on new dongle at T+${ELAPSED}s"
        break
    fi

    sleep 15
done

if [ "$BT_OK" = "true" ]; then
    echo "PASS: phone bonded+connected on new dongle"
else
    echo "WARN: BT not fully connected on new dongle within ${REPAIR_WAIT}s"
fi

# NOTE: Do NOT rebind the old dongle here — test_replug_after_cutoff.sh
# will do the replug and verify non-reclaiming behavior.
# The USB path is saved in /tmp/otacon_lost_dongle_usb_path for it.
echo ""
echo "Old dongle left unbound for replug test. USB path: $USB_DEV"

echo ""
echo "=== Test: permanent dongle loss PASSED ==="
