#!/usr/bin/env bash
# Phase 5b/5c/5d test: Plug new phone -> registry sees discovered+connected within 5s.
#
# NOTE: This test requires physical action (plugging in a phone) or a
# simulation trigger. It polls the registry for a phone that wasn't there
# before, so run it BEFORE plugging in the new device.
#
# Usage: ./test_5bcd_phone_discovery.sh [ADB_SERIAL]
#   If ADB_SERIAL is given, waits for that specific serial.
#   Otherwise, watches for any new phone to appear.

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

TARGET_SERIAL="${1:-}"

echo "=== Test: Phase 5bcd — phone discovery + connected event ==="

# ---- Snapshot: phones before ----
echo ""
echo "--- Snapshot: phones before discovery ---"

PHONES_BEFORE=$(registry_phones)
BEFORE_IDS=$(echo "$PHONES_BEFORE" | jq -r '.[].id' | sort)
BEFORE_COUNT=$(echo "$PHONES_BEFORE" | jq 'length')
observe "Registry has $BEFORE_COUNT phones before discovery"

if [ -n "$TARGET_SERIAL" ]; then
    observe "Waiting for phone with serial: $TARGET_SERIAL"
else
    observe "Waiting for ANY new phone to appear"
fi

echo ""
echo ">>> Plug in the phone now (or trigger discovery). Waiting up to 30s... <<<"
echo ""

# ---- Wait for new phone ----
check_new_phone() {
    local phones_now
    phones_now=$(registry_phones)
    if [ -n "$TARGET_SERIAL" ]; then
        local found
        found=$(echo "$phones_now" | jq -r --arg s "$TARGET_SERIAL" \
            '[.[] | select(.adb_serial == $s)] | length')
        [ "$found" -ge 1 ]
    else
        local now_count
        now_count=$(echo "$phones_now" | jq 'length')
        [ "$now_count" -gt "$BEFORE_COUNT" ]
    fi
}

START_TIME=$(date +%s)

if wait_for 30 "new phone in registry" check_new_phone; then
    END_TIME=$(date +%s)
    ELAPSED=$((END_TIME - START_TIME))
    pass "New phone appeared in registry within ${ELAPSED}s"

    # Check its status
    PHONES_AFTER=$(registry_phones)
    if [ -n "$TARGET_SERIAL" ]; then
        NEW_PHONE=$(echo "$PHONES_AFTER" | jq --arg s "$TARGET_SERIAL" '.[] | select(.adb_serial == $s)')
    else
        AFTER_IDS=$(echo "$PHONES_AFTER" | jq -r '.[].id' | sort)
        NEW_ID=$(comm -13 <(echo "$BEFORE_IDS") <(echo "$AFTER_IDS") | head -1)
        NEW_PHONE=$(echo "$PHONES_AFTER" | jq --arg id "$NEW_ID" '.[] | select(.id == $id)')
    fi

    NEW_STATUS=$(echo "$NEW_PHONE" | jq -r '.status')
    NEW_ID=$(echo "$NEW_PHONE" | jq -r '.id')
    observe "New phone: id=$NEW_ID, status=$NEW_STATUS"

    if [ "$NEW_STATUS" = "connected" ]; then
        pass "New phone status is 'connected'"
    else
        fail "new_phone_status" "Expected 'connected', got '$NEW_STATUS'"
    fi

    if [ "$ELAPSED" -le 5 ]; then
        pass "Discovery latency within 5s target (${ELAPSED}s)"
    else
        observe "Discovery took ${ELAPSED}s (target: 5s)"
        fail "discovery_latency" "Took ${ELAPSED}s, target was 5s"
    fi
else
    fail "phone_discovery" "No new phone appeared within 30s"
fi

finish_test "test_5bcd_phone_discovery"
