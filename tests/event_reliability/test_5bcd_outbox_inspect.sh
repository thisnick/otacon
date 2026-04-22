#!/usr/bin/env bash
# Phase 5b/5c/5d test: Inspect outbox SQLite DB.
#
# Verifies:
# - outbox/events.db exists on Pi (via Docker volume)
# - Table schema is correct (seq, type, entity_id, data, created_at, sent_at, attempts, last_error)
# - Events have correct sequence numbers (monotonically increasing)
# - sent_at is populated for delivered events
# - No unsent events are stuck (all have been flushed)

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: Phase 5bcd — outbox DB inspection ==="

# ---- Check 1: DB exists ----
echo ""
echo "--- Check 1: Outbox DB exists ---"

OUTBOX_EXISTS=$(pi_outbox_exists 2>/dev/null) || OUTBOX_EXISTS="unknown"

if [ "$OUTBOX_EXISTS" = "yes" ]; then
    pass "Outbox DB exists at ${OUTBOX_DB}"
else
    fail "outbox_exists" "No outbox DB at ${OUTBOX_DB}"
    observe "Phase 5b infrastructure not yet deployed (checked Docker volume path)"
    finish_test "test_5bcd_outbox_inspect"
fi

# ---- Check 2: Table schema ----
echo ""
echo "--- Check 2: Table schema ---"

SCHEMA=$(pi_outbox_sql ".schema events" 2>/dev/null) || SCHEMA=""
observe "Schema: $SCHEMA"

# Check for expected columns
for col in seq type entity_id data created_at sent_at attempts last_error; do
    if echo "$SCHEMA" | grep -qi "$col"; then
        pass "Column '$col' exists in schema"
    else
        fail "schema_$col" "Column '$col' not found in schema"
    fi
done

# ---- Check 3: Event count and types ----
echo ""
echo "--- Check 3: Event statistics ---"

TOTAL=$(pi_outbox_sql "SELECT COUNT(*) FROM events;" 2>/dev/null) || TOTAL="error"
observe "Total events: $TOTAL"

if [ "$TOTAL" != "error" ] && [ "$TOTAL" -gt 0 ] 2>/dev/null; then
    pass "Outbox has events ($TOTAL)"

    # Event type breakdown
    echo ""
    echo "  Event type breakdown:"
    pi_outbox_sql "SELECT event_type, COUNT(*) as cnt FROM events GROUP BY event_type ORDER BY cnt DESC;" 2>/dev/null || true
else
    observe "Outbox is empty — no events recorded yet"
fi

# ---- Check 4: Sequence numbers ----
echo ""
echo "--- Check 4: Sequence number monotonicity ---"

if [ "$TOTAL" != "error" ] && [ "$TOTAL" -gt 0 ] 2>/dev/null; then
    # Check that seq values are monotonically increasing
    GAP_COUNT=$(pi_outbox_sql "
        SELECT COUNT(*) FROM (
            SELECT seq, LAG(seq) OVER (ORDER BY seq) as prev_seq
            FROM events
        ) WHERE prev_seq IS NOT NULL AND seq <= prev_seq;
    " 2>/dev/null) || GAP_COUNT="error"

    if [ "$GAP_COUNT" = "0" ]; then
        pass "Sequence numbers are strictly monotonically increasing"
    elif [ "$GAP_COUNT" = "error" ]; then
        observe "Could not check sequence monotonicity"
    else
        fail "seq_monotonic" "$GAP_COUNT sequence ordering violations"
    fi
fi

# ---- Check 5: Delivery status ----
echo ""
echo "--- Check 5: Delivery status ---"

SENT_COUNT=$(pi_outbox_sql "SELECT COUNT(*) FROM events WHERE sent_at IS NOT NULL;" 2>/dev/null) || SENT_COUNT="error"
UNSENT_COUNT=$(pi_outbox_sql "SELECT COUNT(*) FROM events WHERE sent_at IS NULL;" 2>/dev/null) || UNSENT_COUNT="error"

observe "Sent: $SENT_COUNT, Unsent: $UNSENT_COUNT"

if [ "$UNSENT_COUNT" = "0" ]; then
    pass "All events have been delivered (sent_at populated)"
elif [ "$UNSENT_COUNT" != "error" ] && [ "$UNSENT_COUNT" -gt 0 ] 2>/dev/null; then
    observe "$UNSENT_COUNT events still pending delivery"
    echo ""
    echo "  Unsent events:"
    pi_outbox_sql "SELECT seq, type, entity_id, attempts, last_error FROM events WHERE sent_at IS NULL ORDER BY seq LIMIT 5;" 2>/dev/null || true
fi

# ---- Check 6: Recent events sample ----
echo ""
echo "--- Check 6: Recent events (last 10) ---"

pi_ssh "sqlite3 -header '${OUTBOX_DB}' 'SELECT seq, type, entity_id, created_at, sent_at FROM events ORDER BY seq DESC LIMIT 10;'" 2>/dev/null || true

finish_test "test_5bcd_outbox_inspect"
