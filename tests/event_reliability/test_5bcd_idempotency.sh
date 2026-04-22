#!/usr/bin/env bash
# Phase 5b/5c/5d test: Idempotency — replay an event by setting sent_at=NULL.
# Registry state should be unchanged after re-delivery.
#
# Verifies:
# - Reset sent_at=NULL on a delivered event
# - Flusher re-sends it
# - Registry state matches what it was before replay

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: Phase 5bcd — event replay idempotency ==="

# ---- Pre-check: outbox exists ----
OUTBOX_EXISTS=$(pi_outbox_exists 2>/dev/null) || OUTBOX_EXISTS="unknown"

if [ "$OUTBOX_EXISTS" != "yes" ]; then
    observe "No outbox DB — Phase 5b not deployed yet"
    fail "outbox_exists" "Cannot test idempotency without outbox"
    finish_test "test_5bcd_idempotency"
fi

# ---- Step 1: Snapshot registry state ----
echo ""
echo "--- Step 1: Snapshot registry phone state ---"

PHONES_BEFORE=$(registry_phones)
observe "Registry phone count: $(echo "$PHONES_BEFORE" | jq 'length')"

# ---- Step 2: Pick a delivered event to replay ----
echo ""
echo "--- Step 2: Pick a delivered event to replay ---"

# Pick the most recent sent event
REPLAY_SEQ=$(pi_outbox_sql "SELECT seq FROM events WHERE sent_at IS NOT NULL ORDER BY seq DESC LIMIT 1;" 2>/dev/null) || REPLAY_SEQ=""

if [ -z "$REPLAY_SEQ" ]; then
    observe "No delivered events to replay"
    fail "no_sent_events" "Cannot find a delivered event to replay"
    finish_test "test_5bcd_idempotency"
fi

REPLAY_EVENT=$(pi_ssh "sqlite3 -header '${OUTBOX_DB}' \"SELECT seq, type, entity_id FROM events WHERE seq = $REPLAY_SEQ;\"" 2>/dev/null) || true
observe "Replaying event: $REPLAY_EVENT"

# ---- Step 3: Reset sent_at to force re-delivery ----
echo ""
echo "--- Step 3: Reset sent_at=NULL on event seq=$REPLAY_SEQ ---"

pi_outbox_sql "UPDATE events SET sent_at = NULL WHERE seq = $REPLAY_SEQ;" 2>/dev/null

VERIFY=$(pi_outbox_sql "SELECT sent_at FROM events WHERE seq = $REPLAY_SEQ;" 2>/dev/null) || VERIFY="error"
if [ -z "$VERIFY" ] || [ "$VERIFY" = "" ]; then
    pass "Event seq=$REPLAY_SEQ sent_at reset to NULL"
else
    fail "reset_sent_at" "sent_at is still '$VERIFY'"
fi

# ---- Step 4: Wait for flusher to re-send ----
echo ""
echo "--- Step 4: Waiting for flusher to re-deliver (up to 15s) ---"

check_resent() {
    local sent
    sent=$(pi_outbox_sql "SELECT sent_at FROM events WHERE seq = $REPLAY_SEQ;" 2>/dev/null) || return 1
    [ -n "$sent" ] && [ "$sent" != "" ]
}

if wait_for 15 "event re-delivered" check_resent; then
    pass "Event seq=$REPLAY_SEQ re-delivered by flusher"
else
    fail "replay_delivery" "Event was not re-delivered within 15s"
fi

# ---- Step 5: Verify registry state unchanged ----
echo ""
echo "--- Step 5: Verify registry state is unchanged ---"

PHONES_AFTER=$(registry_phones)

# Compare phone count
BEFORE_COUNT=$(echo "$PHONES_BEFORE" | jq 'length')
AFTER_COUNT=$(echo "$PHONES_AFTER" | jq 'length')

if [ "$BEFORE_COUNT" = "$AFTER_COUNT" ]; then
    pass "Phone count unchanged: $BEFORE_COUNT"
else
    fail "phone_count_changed" "Was $BEFORE_COUNT, now $AFTER_COUNT"
fi

# Compare statuses for each phone
CHANGED=0
for phone_id in $(echo "$PHONES_BEFORE" | jq -r '.[].id'); do
    STATUS_BEFORE=$(echo "$PHONES_BEFORE" | jq -r --arg id "$phone_id" '.[] | select(.id == $id) | .status')
    STATUS_AFTER=$(echo "$PHONES_AFTER" | jq -r --arg id "$phone_id" '.[] | select(.id == $id) | .status')
    if [ "$STATUS_BEFORE" != "$STATUS_AFTER" ]; then
        observe "Phone '$phone_id' status changed: $STATUS_BEFORE -> $STATUS_AFTER"
        CHANGED=$((CHANGED + 1))
    fi
done

if [ "$CHANGED" = "0" ]; then
    pass "All phone statuses unchanged after replay (idempotent)"
else
    fail "idempotency" "$CHANGED phones changed status after event replay"
fi

finish_test "test_5bcd_idempotency"
