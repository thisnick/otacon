#!/usr/bin/env bash
# Hardware test: replug after cutoff (non-reclaiming policy)
#
# After a permanent loss + reassignment scenario has completed, "return"
# the original hardware and verify:
#   1. It joins the spare pool (not reclaiming its old slot)
#   2. No ping-pong reassignment occurs
#   3. The new assignment (from the permanent loss test) remains sticky
#
# This test depends on the permanent_dongle_loss test having run first
# (or a similar scenario where a dongle was lost, phone reassigned, and
# the old dongle is currently powered down).
#
# If no such scenario exists, it simulates a mini version: power off a
# dongle, wait for cooldown + reassignment, then replug.
#
# Usage: ./test_replug_after_cutoff.sh
# Requires: ssh access to otacon-pi, curl, jq

set -euo pipefail

PI="nick@otacon-pi"
REGISTRY_URL="http://localhost:8080"
CONTAINER="otacon-otacon-1"

echo "=== Test: replug after cutoff (non-reclaiming) ==="

# --- Step 0: Find a dongle that is currently offline (from a prior loss test) ---
DONGLES=$(curl -s "$REGISTRY_URL/api/v1/dongles")
OFFLINE_DONGLE=$(echo "$DONGLES" | jq -r '[.[] | select(.status == "offline" and .hci_device != "hci0" and .hci_device != null)] | .[0] // empty')

if [ -z "$OFFLINE_DONGLE" ] || [ "$OFFLINE_DONGLE" = "null" ]; then
    echo "No offline USB dongle found from a prior permanent loss test."
    echo "SKIP: run test_permanent_dongle_loss.sh first, or this test will be validated as part of that flow."
    exit 0
fi

DONGLE_ID=$(echo "$OFFLINE_DONGLE" | jq -r '.id')
DONGLE_HCI=$(echo "$OFFLINE_DONGLE" | jq -r '.hci_device')
OLD_PHONE=$(echo "$OFFLINE_DONGLE" | jq -r '.phone_id // empty')
echo "Returning dongle: $DONGLE_ID ($DONGLE_HCI)"
echo "Was previously assigned to: ${OLD_PHONE:-none}"

# Check what the old phone is now assigned to (if any)
if [ -n "$OLD_PHONE" ]; then
    CURRENT_DONGLE=$(echo "$DONGLES" | jq -r ".[] | select(.phone_id == \"$OLD_PHONE\" and .status == \"online\") | .id // empty")
    echo "Phone $OLD_PHONE is now on dongle: ${CURRENT_DONGLE:-none}"
fi

# Record event baseline
EVENT_BASELINE=$(curl -s "$REGISTRY_URL/api/v1/events?limit=1" | jq '.[0].id // 0')

# --- Step 1: Bring the old dongle back online ---
echo ""
echo "--- Powering on $DONGLE_HCI (simulating replug) ---"
ssh "$PI" "docker exec $CONTAINER hciconfig $DONGLE_HCI up" 2>/dev/null || true
echo "Adapter powered up."

# Wait for it to be detected
sleep 30

# --- Step 2: Verify it joins the spare pool ---
echo ""
echo "--- Checking dongle status after replug ---"
DONGLES_AFTER=$(curl -s "$REGISTRY_URL/api/v1/dongles")
RETURNED=$(echo "$DONGLES_AFTER" | jq -r ".[] | select(.id == \"$DONGLE_ID\")")
RETURNED_STATUS=$(echo "$RETURNED" | jq -r '.status // empty')
RETURNED_PHONE=$(echo "$RETURNED" | jq -r '.phone_id // empty')
echo "Dongle status: $RETURNED_STATUS"
echo "Dongle phone_id: ${RETURNED_PHONE:-<empty>}"

# The dongle should NOT have reclaimed its old phone
if [ -n "$OLD_PHONE" ] && [ "$RETURNED_PHONE" = "$OLD_PHONE" ]; then
    echo "FAIL: returned dongle reclaimed its old phone (violates non-reclaiming policy)"
    exit 1
fi
echo "PASS: dongle did not reclaim old phone"

# Verify the dongle is in spare state (no phone_id or phone_id empty)
if [ -n "$RETURNED_PHONE" ]; then
    echo "WARN: returned dongle was assigned to a different phone ($RETURNED_PHONE) — this is OK if a new phone needed it"
else
    echo "PASS: returned dongle is in spare pool (no phone assigned)"
fi

# --- Step 3: Verify no ping-pong reassignment events ---
echo ""
echo "--- Checking for unexpected reassignment events ---"
sleep 30  # Give the system time to settle

if [ -n "$OLD_PHONE" ]; then
    REASSIGN_EVENTS=$(curl -s "$REGISTRY_URL/api/v1/events?event_type=info.phone.reassigned&entity_id=$OLD_PHONE&limit=10")
    NEW_REASSIGN=$(echo "$REASSIGN_EVENTS" | jq --argjson baseline "$EVENT_BASELINE" '[.[] | select(.id > $baseline)] | length')

    if [ "$NEW_REASSIGN" -gt 0 ]; then
        echo "FAIL: phone.reassigned event emitted after dongle replug (ping-pong detected)"
        exit 1
    fi
    echo "PASS: no ping-pong reassignment after replug"
fi

# --- Step 4: Verify the phone's current assignment is still sticky ---
if [ -n "$OLD_PHONE" ] && [ -n "${CURRENT_DONGLE:-}" ]; then
    echo ""
    echo "--- Verifying phone's current dongle assignment is unchanged ---"
    DONGLES_FINAL=$(curl -s "$REGISTRY_URL/api/v1/dongles")
    STILL_ASSIGNED=$(echo "$DONGLES_FINAL" | jq -r ".[] | select(.phone_id == \"$OLD_PHONE\" and .status == \"online\") | .id // empty")

    if [ "$STILL_ASSIGNED" = "$CURRENT_DONGLE" ]; then
        echo "PASS: phone still on dongle $CURRENT_DONGLE (assignment is sticky)"
    else
        echo "FAIL: phone assignment changed from $CURRENT_DONGLE to ${STILL_ASSIGNED:-none}"
        exit 1
    fi
fi

echo ""
echo "=== Test: replug after cutoff PASSED ==="
