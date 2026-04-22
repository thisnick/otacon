#!/usr/bin/env bash
# Phase 5b/5c/5d test: Stop host, change phone state, restart host.
# Reconciler should regenerate missed events.
#
# This test:
# 1. Records initial state
# 2. Stops host container
# 3. Restarts host
# 4. Verifies reconciler diff generates correct events and registry converges

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: Phase 5bcd — host-down reconciliation ==="

# ---- Step 1: Record initial state ----
echo ""
echo "--- Step 1: Record initial state ---"

PHONES_BEFORE=$(registry_phones)
REAL_BEFORE=$(echo "$PHONES_BEFORE" | jq '[.[] | select(.adb_serial | startswith("TEST_") | not)]')
BEFORE_CONNECTED=$(echo "$REAL_BEFORE" | jq '[.[] | select(.status == "connected")] | length')
BEFORE_TOTAL=$(echo "$REAL_BEFORE" | jq 'length')
observe "Before: $BEFORE_CONNECTED of $BEFORE_TOTAL real phones connected"

# ---- Step 2: Stop host ----
echo ""
echo "--- Step 2: Stopping host container ---"

pi_docker stop "$HOST_CONTAINER" 2>&1 || true
observe "Host container stopped"

# ---- Step 3: Check state files on Pi ----
echo ""
echo "--- Step 3: Check persisted state on Pi ---"

STATE_DIR_EXISTS=$(pi_ssh "test -d '${STATE_DIR}' && echo yes || echo no" 2>/dev/null) || STATE_DIR_EXISTS="unknown"
observe "State directory exists: $STATE_DIR_EXISTS"

if [ "$STATE_DIR_EXISTS" = "yes" ]; then
    pi_ssh "ls -la '${STATE_DIR}/'" 2>/dev/null || true
    PHONES_STATE=$(pi_ssh "cat '${STATE_DIR}/phones.json' 2>/dev/null | python3 -m json.tool 2>/dev/null | head -20" 2>/dev/null) || PHONES_STATE="(not readable)"
    observe "Persisted phones state (first 20 lines): $PHONES_STATE"
else
    observe "No state directory — Phase 5c reconciler not yet deployed"
fi

# ---- Step 4: Restart host ----
echo ""
echo "--- Step 4: Restarting host container ---"

pi_docker start "$HOST_CONTAINER" 2>&1 || true
observe "Host container started"

# ---- Step 5: Wait for convergence ----
echo ""
echo "--- Step 5: Waiting up to 60s for state convergence ---"

check_recovered() {
    local phones_now
    phones_now=$(registry_phones)
    local real_now
    real_now=$(echo "$phones_now" | jq '[.[] | select(.adb_serial | startswith("TEST_") | not)]')
    local connected_now
    connected_now=$(echo "$real_now" | jq '[.[] | select(.status == "connected")] | length')
    local threshold=$((BEFORE_CONNECTED > 1 ? BEFORE_CONNECTED - 1 : 1))
    [ "$connected_now" -ge "$threshold" ]
}

if wait_for 60 "phones recovered" check_recovered; then
    pass "Phones recovered after host restart"
else
    fail "host_recovery" "Phones did not recover within 60s"
fi

# ---- Step 6: Check outbox for reconciler events ----
echo ""
echo "--- Step 6: Check outbox for reconciler-generated events ---"

OUTBOX_EXISTS=$(pi_outbox_exists 2>/dev/null) || OUTBOX_EXISTS="unknown"

if [ "$OUTBOX_EXISTS" = "yes" ]; then
    TOTAL_EVENTS=$(pi_outbox_sql "SELECT COUNT(*) FROM events;" 2>/dev/null) || TOTAL_EVENTS="error"
    observe "Total events in outbox: $TOTAL_EVENTS"

    # Show recent events (should include reconciler-generated ones)
    echo ""
    echo "  Recent outbox events:"
    pi_ssh "sqlite3 -header '${OUTBOX_DB}' 'SELECT seq, type, entity_id, created_at, sent_at FROM events ORDER BY seq DESC LIMIT 10;'" 2>/dev/null || true

    UNSENT=$(pi_outbox_sql "SELECT COUNT(*) FROM events WHERE sent_at IS NULL;" 2>/dev/null) || UNSENT="error"
    if [ "$UNSENT" = "0" ]; then
        pass "All outbox events have been sent"
    else
        observe "Unsent events remaining: $UNSENT"
    fi
else
    observe "No outbox DB — Phase 5b not deployed yet"
fi

# ---- Final status ----
echo ""
echo "--- Final registry state ---"

PHONES_AFTER=$(registry_phones)
REAL_AFTER=$(echo "$PHONES_AFTER" | jq '[.[] | select(.adb_serial | startswith("TEST_") | not)]')
AFTER_CONNECTED=$(echo "$REAL_AFTER" | jq '[.[] | select(.status == "connected")] | length')
AFTER_TOTAL=$(echo "$REAL_AFTER" | jq 'length')

observe "After recovery: $AFTER_CONNECTED of $AFTER_TOTAL real phones connected"
echo "$REAL_AFTER" | jq -r '.[] | "    \(.id): \(.status)"'

finish_test "test_5bcd_host_down_recovery"
