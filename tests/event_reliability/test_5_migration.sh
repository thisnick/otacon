#!/usr/bin/env bash
# Phase 5 migration test: Existing Pi gets new build.
#
# Verifies:
# - Outbox contains ONE host.snapshot event (not N discovered events)
# - After flush, registry state matches host observation
# - No flood of individual phone.discovered events for already-known phones

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: Phase 5 — migration (first boot with outbox) ==="

# ---- Check 1: Outbox exists ----
echo ""
echo "--- Check 1: Outbox DB exists ---"

OUTBOX_EXISTS=$(pi_outbox_exists 2>/dev/null) || OUTBOX_EXISTS="unknown"

if [ "$OUTBOX_EXISTS" != "yes" ]; then
    observe "No outbox DB — Phase 5b not deployed yet (migration test N/A)"
    finish_test "test_5_migration"
fi

pass "Outbox DB exists"

# ---- Check 2: Look for host.snapshot event ----
echo ""
echo "--- Check 2: host.snapshot event in outbox ---"

SNAPSHOT_COUNT=$(pi_outbox_sql "SELECT COUNT(*) FROM events WHERE event_type = 'host.snapshot';" 2>/dev/null) || SNAPSHOT_COUNT="error"

observe "host.snapshot events in outbox: $SNAPSHOT_COUNT"

if [ "$SNAPSHOT_COUNT" != "error" ] && [ "$SNAPSHOT_COUNT" -ge 1 ] 2>/dev/null; then
    pass "At least one host.snapshot event exists"
else
    fail "no_snapshot" "Expected at least 1 host.snapshot event, found $SNAPSHOT_COUNT"
fi

# ---- Check 3: No flood of discovered events ----
echo ""
echo "--- Check 3: No flood of individual discovered events on first boot ---"

DISCOVERED_COUNT=$(pi_outbox_sql "SELECT COUNT(*) FROM events WHERE event_type = 'phone.discovered';" 2>/dev/null) || DISCOVERED_COUNT="error"

observe "phone.discovered events: $DISCOVERED_COUNT"

# On migration, we expect 0 or very few discovered events — the snapshot handles everything.
# If there are as many discovered events as phones, that's a flood.
PHONE_COUNT=$(registry_phones | jq '[.[] | select(.adb_serial | startswith("TEST_") | not)] | length')

if [ "$DISCOVERED_COUNT" != "error" ] && [ "$DISCOVERED_COUNT" -le 2 ] 2>/dev/null; then
    pass "No flood of discovered events ($DISCOVERED_COUNT discovered vs $PHONE_COUNT phones)"
elif [ "$DISCOVERED_COUNT" != "error" ] && [ "$DISCOVERED_COUNT" -ge "$PHONE_COUNT" ] 2>/dev/null; then
    fail "discovered_flood" "$DISCOVERED_COUNT discovered events for $PHONE_COUNT phones — snapshot should handle migration"
else
    observe "phone.discovered count: $DISCOVERED_COUNT (could not determine if this is a flood)"
fi

# ---- Check 4: Registry matches host observation ----
echo ""
echo "--- Check 4: Registry state matches host observation ---"

# Get phones from the host's local API (internal port on the Pi)
HOST_PHONES=$(pi_ssh "curl -s http://localhost:8081/phones 2>/dev/null" 2>/dev/null) || HOST_PHONES="[]"
HOST_PHONE_COUNT=$(echo "$HOST_PHONES" | jq 'length' 2>/dev/null) || HOST_PHONE_COUNT="error"
HOST_CONNECTED=$(echo "$HOST_PHONES" | jq '[.[] | select(.status == "connected")] | length' 2>/dev/null) || HOST_CONNECTED="error"

observe "Host reports: $HOST_PHONE_COUNT phones, $HOST_CONNECTED connected"

REGISTRY_PHONES_JSON=$(registry_phones)
REG_REAL=$(echo "$REGISTRY_PHONES_JSON" | jq '[.[] | select(.adb_serial | startswith("TEST_") | not)]')
REG_CONNECTED=$(echo "$REG_REAL" | jq '[.[] | select(.status == "connected")] | length')
REG_TOTAL=$(echo "$REG_REAL" | jq 'length')

observe "Registry reports: $REG_TOTAL real phones, $REG_CONNECTED connected"

# Compare host serials vs registry serials
HOST_SERIALS=$(echo "$HOST_PHONES" | jq -r '.[].adb_serial' 2>/dev/null | sort)
REG_SERIALS=$(echo "$REG_REAL" | jq -r '.[].adb_serial' | sort)

MISSING_IN_REGISTRY=$(comm -23 <(echo "$HOST_SERIALS") <(echo "$REG_SERIALS"))
if [ -z "$MISSING_IN_REGISTRY" ]; then
    pass "All host phones present in registry"
else
    observe "Phones on host but not in registry:"
    echo "$MISSING_IN_REGISTRY" | while read -r s; do echo "    $s"; done
    fail "missing_phones" "Some host phones not in registry after migration"
fi

# ---- Check 5: Event type breakdown ----
echo ""
echo "--- Check 5: Full outbox event breakdown ---"

pi_ssh "sqlite3 -header '${OUTBOX_DB}' 'SELECT event_type, COUNT(*) as cnt FROM events GROUP BY event_type ORDER BY cnt DESC;'" 2>/dev/null || true

finish_test "test_5_migration"
