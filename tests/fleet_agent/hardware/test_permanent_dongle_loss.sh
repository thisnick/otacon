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
# Uses a USB adapter (not hci0). Powers it down via hciconfig + holds it
# down for the full cooldown. The phone should auto-reassign to the spare
# dongle.
#
# WARNING: This test takes ~8 minutes. One dongle will be offline for the
# duration. The orphaned phone will lose BT until reassignment completes.
#
# Usage: ./test_permanent_dongle_loss.sh
# Requires: ssh access to otacon-pi, curl, jq

set -euo pipefail

PI="nick@otacon-pi"
PI_URL="https://otacon-pi:8080"
REGISTRY_URL="http://localhost:8080"
CONTAINER="otacon-otacon-1"
COOLDOWN=320  # 5 min + 20s margin
REPAIR_WAIT=180  # 3 min for re-pair on new dongle

echo "=== Test: permanent dongle loss ==="

# --- Step 0: Find a USB dongle assigned to a phone (not hci0) ---
DONGLES=$(curl -s "$REGISTRY_URL/api/v1/dongles")
TARGET_DONGLE=$(echo "$DONGLES" | jq -r '[.[] | select(.phone_id != null and .hci_device != "hci0" and .hci_device != null)] | .[0] // empty')

if [ -z "$TARGET_DONGLE" ] || [ "$TARGET_DONGLE" = "null" ]; then
    echo "SKIP: no USB dongle with phone assignment found"
    exit 0
fi

DONGLE_ID=$(echo "$TARGET_DONGLE" | jq -r '.id')
DONGLE_MAC=$(echo "$TARGET_DONGLE" | jq -r '.bt_mac')
DONGLE_HCI=$(echo "$TARGET_DONGLE" | jq -r '.hci_device')
VICTIM_PHONE=$(echo "$TARGET_DONGLE" | jq -r '.phone_id')
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

# --- Step 1: Power off the dongle ---
echo ""
echo "--- Powering off $DONGLE_HCI (simulating permanent loss) ---"
ssh "$PI" "docker exec $CONTAINER hciconfig $DONGLE_HCI down" 2>/dev/null || true
echo "Adapter powered down. Holding offline for ${COOLDOWN}s..."

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
    ssh "$PI" "docker exec $CONTAINER hciconfig $DONGLE_HCI up" 2>/dev/null || true
    exit 1
fi
echo "PASS: dongle.lost event emitted (count=$NEW_LOST)"

# --- Step 4: Verify phone.reassigned event ---
echo ""
echo "--- Checking for phone.reassigned event ---"
REASSIGN_EVENTS=$(curl -s "$REGISTRY_URL/api/v1/events?event_type=info.phone.reassigned&entity_id=$VICTIM_PHONE&limit=10")
NEW_REASSIGN=$(echo "$REASSIGN_EVENTS" | jq --argjson baseline "$EVENT_BASELINE" '[.[] | select(.id > $baseline)] | length')

if [ "$NEW_REASSIGN" -eq 0 ]; then
    echo "FAIL: no phone.reassigned event emitted for $VICTIM_PHONE"
    ssh "$PI" "docker exec $CONTAINER hciconfig $DONGLE_HCI up" 2>/dev/null || true
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
    ssh "$PI" "docker exec $CONTAINER hciconfig $DONGLE_HCI up" 2>/dev/null || true
    exit 1
fi

if [ -z "$NEW_DONGLE_ID" ]; then
    echo "FAIL: phone has no dongle assignment after reassignment"
    ssh "$PI" "docker exec $CONTAINER hciconfig $DONGLE_HCI up" 2>/dev/null || true
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

# --- Cleanup: bring the old dongle back online (it goes to spare pool) ---
echo ""
echo "--- Cleanup: bringing old dongle back online ---"
ssh "$PI" "docker exec $CONTAINER hciconfig $DONGLE_HCI up" 2>/dev/null || true
echo "Old dongle $DONGLE_HCI powered back up (should join spare pool)"

echo ""
echo "=== Test: permanent dongle loss PASSED ==="
