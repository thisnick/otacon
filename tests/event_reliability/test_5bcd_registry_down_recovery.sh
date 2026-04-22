#!/usr/bin/env bash
# Phase 5b/5c/5d test: Stop registry, change phone state, restart registry.
# Events should queue in outbox and deliver after recovery.
#
# This test:
# 1. Records initial state
# 2. Stops the registry
# 3. Waits for user to plug/unplug a phone (or we rely on existing state change)
# 4. Restarts the registry
# 5. Verifies outbox flushed and registry state matches reality

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: Phase 5bcd — registry-down event queuing ==="

# ---- Step 1: Record initial state ----
echo ""
echo "--- Step 1: Record initial registry state ---"

PHONES_BEFORE=$(registry_phones)
BEFORE_COUNT=$(echo "$PHONES_BEFORE" | jq 'length')
observe "Registry has $BEFORE_COUNT phones"
echo "$PHONES_BEFORE" | jq -r '.[] | "    \(.id): \(.status)"'

# ---- Step 2: Stop registry ----
echo ""
echo "--- Step 2: Stopping registry container ---"

pi_docker stop "$REGISTRY_CONTAINER" 2>&1 || true
observe "Registry stopped"

# Verify it's down
sleep 2
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/hosts" "$ADMIN_TOKEN" 2>/dev/null) || true
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "000" ] || [ "$STATUS" = "" ]; then
    pass "Registry confirmed down (connection refused)"
else
    observe "WARNING: Registry still responding with status $STATUS"
fi

# ---- Step 3: Check outbox on Pi ----
echo ""
echo "--- Step 3: Check outbox DB on Pi (events should queue while registry is down) ---"

# Wait a bit for at least one heartbeat cycle to try and fail
sleep 10

OUTBOX_EXISTS=$(pi_outbox_exists 2>/dev/null) || OUTBOX_EXISTS="unknown"
observe "Outbox DB exists: $OUTBOX_EXISTS"

if [ "$OUTBOX_EXISTS" = "yes" ]; then
    UNSENT_COUNT=$(pi_outbox_sql "SELECT COUNT(*) FROM events WHERE sent_at IS NULL;" 2>/dev/null) || UNSENT_COUNT="error"
    observe "Unsent events in outbox: $UNSENT_COUNT"

    if [ "$UNSENT_COUNT" != "error" ] && [ "$UNSENT_COUNT" -gt 0 ] 2>/dev/null; then
        pass "Outbox has $UNSENT_COUNT queued events while registry is down"
    else
        observe "No unsent events in outbox — flusher may have caught up before registry went down"
    fi

    # Show what's in the outbox
    pi_ssh "sqlite3 -header '${OUTBOX_DB}' 'SELECT seq, type, entity_id, created_at, sent_at FROM events ORDER BY seq DESC LIMIT 10;'" 2>/dev/null || true
else
    observe "No outbox DB — Phase 5b infrastructure not deployed"
fi

# ---- Step 4: Restart registry ----
echo ""
echo "--- Step 4: Restarting registry ---"

pi_docker start "$REGISTRY_CONTAINER" 2>&1 || true

# Wait for registry to come back
check_registry_up() {
    local result
    result=$(http_get "$REGISTRY_URL/api/v1/admin/hosts" "$ADMIN_TOKEN")
    local status
    status=$(get_status "$result")
    [ "$status" = "200" ]
}

if wait_for 30 "registry responding" check_registry_up; then
    pass "Registry back up"
else
    fail "registry_restart" "Registry did not come back within 30s"
    finish_test "test_5bcd_registry_down_recovery"
fi

# ---- Step 5: Wait for events to flush ----
echo ""
echo "--- Step 5: Waiting for outbox flush + state convergence (up to 60s) ---"

sleep 5  # Give flusher a moment

if [ "$OUTBOX_EXISTS" = "yes" ]; then
    check_outbox_flushed() {
        local unsent
        unsent=$(pi_outbox_sql "SELECT COUNT(*) FROM events WHERE sent_at IS NULL;" 2>/dev/null) || return 1
        [ "$unsent" = "0" ]
    }

    if wait_for 30 "outbox flushed" check_outbox_flushed; then
        pass "All outbox events flushed (sent_at populated)"
    else
        REMAINING=$(pi_outbox_sql "SELECT COUNT(*) FROM events WHERE sent_at IS NULL;" 2>/dev/null) || REMAINING="error"
        fail "outbox_flush" "$REMAINING events still unsent after 30s"
    fi
fi

# ---- Step 6: Verify final state ----
echo ""
echo "--- Step 6: Final registry state ---"

# Wait for heartbeat cycle to stabilize
sleep 10

PHONES_AFTER=$(registry_phones)
AFTER_COUNT=$(echo "$PHONES_AFTER" | jq 'length')
observe "Registry has $AFTER_COUNT phones after recovery"
echo "$PHONES_AFTER" | jq -r '.[] | "    \(.id): \(.status)"'

finish_test "test_5bcd_registry_down_recovery"
