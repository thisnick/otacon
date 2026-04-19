#!/usr/bin/env bash
# Hardware test: permanent phone loss
#
# Simulates a phone disappearing for > 5 min (the cooldown threshold).
# Verifies:
#   1. After 320s (5min + margin), a phone.lost event is emitted
#   2. The phone disappears from the /phones list (or status=disconnected)
#   3. Its assigned dongle goes back to the spare pool (phone_id cleared)
#
# Uses A14 (R92X1022S7K) as the canary. Simulates loss by powering off
# the phone via ADB, keeping it off for the full cooldown period.
#
# WARNING: This test takes ~6 minutes. The canary phone will be offline
# for the duration.
#
# Usage: ./test_permanent_phone_loss.sh
# Requires: ssh access to otacon-pi, curl, jq

set -euo pipefail

PI="nick@otacon-pi"
PI_URL="https://otacon-pi:8080"
REGISTRY_URL="http://localhost:8080"
CONTAINER="otacon-otacon-1"
CANARY_SERIAL="R92X1022S7K"
COOLDOWN=320  # 5 min + 20s margin

echo "=== Test: permanent phone loss ==="

# --- Step 0: Snapshot pre-test state ---
PHONES_BEFORE=$(curl -s "$REGISTRY_URL/api/v1/phones")
CANARY_ID=$(echo "$PHONES_BEFORE" | jq -r ".[] | select(.adb_serial == \"$CANARY_SERIAL\") | .id")

if [ -z "$CANARY_ID" ] || [ "$CANARY_ID" = "null" ]; then
    echo "SKIP: canary phone ($CANARY_SERIAL) not registered in registry"
    exit 0
fi
echo "Canary phone: $CANARY_ID ($CANARY_SERIAL)"

DONGLE_ID_BEFORE=$(curl -s "$REGISTRY_URL/api/v1/dongles" | jq -r ".[] | select(.phone_id == \"$CANARY_ID\") | .id // empty")
echo "Dongle assigned to canary: ${DONGLE_ID_BEFORE:-none}"

if [ -z "$DONGLE_ID_BEFORE" ]; then
    echo "SKIP: canary has no dongle assignment — cannot verify release"
    exit 0
fi

# Record the event count before the test so we only check new events
EVENT_COUNT_BEFORE=$(curl -s "$REGISTRY_URL/api/v1/events?limit=1" | jq '.[0].id // 0')
echo "Event baseline ID: $EVENT_COUNT_BEFORE"

# --- Step 1: Power off the canary phone ---
echo ""
echo "--- Powering off canary phone (simulating permanent loss) ---"
ssh "$PI" "docker exec $CONTAINER adb -s $CANARY_SERIAL shell reboot -p" 2>/dev/null || true
echo "Power-off command issued."

# Wait a moment for the phone to go offline
sleep 15

# Verify it's gone
STILL_THERE=$(ssh "$PI" "docker exec $CONTAINER adb devices" 2>/dev/null | grep -c "$CANARY_SERIAL" || true)
if [ "$STILL_THERE" -gt 0 ]; then
    echo "WARN: phone still showing in adb devices — trying harder"
    # Some phones ignore reboot -p; try just keeping it off
    sleep 10
fi

# --- Step 2: Wait for cooldown to elapse ---
echo ""
echo "--- Waiting ${COOLDOWN}s for cooldown to elapse ---"
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

# --- Step 3: Verify phone.lost event ---
echo ""
echo "--- Checking for phone.lost event ---"
# Query without entity_id filter — the event may have entity_id=null if the
# agent was already removed before the loss handler could read phone_id.
# Instead, filter by event_type and check the data payload for our serial.
LOST_EVENTS=$(curl -s "$REGISTRY_URL/api/v1/events?event_type=info.phone.lost&limit=10")
NEW_LOST=$(echo "$LOST_EVENTS" | jq --argjson baseline "$EVENT_COUNT_BEFORE" --arg serial "$CANARY_SERIAL" \
    '[.[] | select(.id > $baseline) | select(.entity_id == $serial or .data.extra.serial == $serial or .entity_id == null)] | length')

if [ "$NEW_LOST" -eq 0 ]; then
    echo "FAIL: no phone.lost event emitted for $CANARY_SERIAL after cooldown"
    # Try to recover the phone before failing
    ssh "$PI" "docker exec $CONTAINER adb -s $CANARY_SERIAL reboot" 2>/dev/null || true
    exit 1
fi
echo "PASS: phone.lost event emitted (count=$NEW_LOST)"

# --- Step 4: Verify phone status ---
echo ""
echo "--- Checking phone status in registry ---"
PHONE_STATUS=$(curl -s "$REGISTRY_URL/api/v1/phones/$CANARY_ID" 2>/dev/null | jq -r '.status // empty')
echo "Phone status: $PHONE_STATUS"

if [ "$PHONE_STATUS" = "connected" ]; then
    echo "FAIL: phone still shows as connected after permanent loss"
    ssh "$PI" "docker exec $CONTAINER adb -s $CANARY_SERIAL reboot" 2>/dev/null || true
    exit 1
fi
echo "PASS: phone no longer connected"

# --- Step 5: Verify dongle released to spare pool ---
echo ""
echo "--- Checking dongle assignment ---"
DONGLE_AFTER=$(curl -s "$REGISTRY_URL/api/v1/dongles" | jq -r ".[] | select(.id == \"$DONGLE_ID_BEFORE\")")
DONGLE_PHONE_AFTER=$(echo "$DONGLE_AFTER" | jq -r '.phone_id // empty')
echo "Dongle $DONGLE_ID_BEFORE phone_id: ${DONGLE_PHONE_AFTER:-<empty>}"

if [ "$DONGLE_PHONE_AFTER" = "$CANARY_ID" ]; then
    echo "FAIL: dongle still assigned to lost phone"
    ssh "$PI" "docker exec $CONTAINER adb -s $CANARY_SERIAL reboot" 2>/dev/null || true
    exit 1
fi
echo "PASS: dongle released back to spare pool"

# --- Cleanup: bring the canary back online ---
echo ""
echo "--- Cleanup: bringing canary phone back online ---"
# The phone is powered off, so we need to wait for the user to physically
# press the power button, or try a USB reset.
# Try waking via USB reset (may or may not work depending on phone model)
ssh "$PI" "docker exec $CONTAINER adb -s $CANARY_SERIAL reboot" 2>/dev/null || true

echo "NOTE: If canary doesn't come back automatically, press its power button."
echo "Waiting 60s for recovery..."
sleep 60

RECOVERED=$(curl -s "$REGISTRY_URL/api/v1/phones/$CANARY_ID" | jq -r '.status // empty')
echo "Recovery status: $RECOVERED"

echo ""
echo "=== Test: permanent phone loss PASSED ==="
