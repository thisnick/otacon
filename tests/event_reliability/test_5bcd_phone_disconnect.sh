#!/usr/bin/env bash
# Phase 5b/5c/5d test: Disconnect phone -> registry sees disconnected within 5s.
#
# Usage: ./test_5bcd_phone_disconnect.sh <REGISTRY_PHONE_ID>
#   Watches the specified phone's status. Expects it to be "connected" initially,
#   then flip to "disconnected" after the user unplugs it.

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

PHONE_ID="${1:-}"

echo "=== Test: Phase 5bcd — phone disconnect event ==="

if [ -z "$PHONE_ID" ]; then
    echo "Usage: $0 <REGISTRY_PHONE_ID>"
    echo ""
    echo "Available phones:"
    registry_phones | jq -r '.[] | "  \(.id)  serial=\(.adb_serial)  status=\(.status)"'
    exit 2
fi

# ---- Pre-check: phone should be connected ----
echo ""
echo "--- Pre-check: phone status ---"

INITIAL_STATUS=$(registry_phone_status "$PHONE_ID")
observe "Phone '$PHONE_ID' current status: $INITIAL_STATUS"

if [ "$INITIAL_STATUS" != "connected" ]; then
    observe "WARNING: phone is not 'connected' — test may not be meaningful"
fi

echo ""
echo ">>> Unplug phone '$PHONE_ID' now. Waiting up to 30s for disconnect... <<<"
echo ""

# ---- Wait for disconnect ----
check_disconnected() {
    local status
    status=$(registry_phone_status "$PHONE_ID")
    [ "$status" = "disconnected" ] || [ "$status" = "unreachable" ]
}

START_TIME=$(date +%s)

if wait_for 30 "phone disconnected" check_disconnected; then
    END_TIME=$(date +%s)
    ELAPSED=$((END_TIME - START_TIME))
    FINAL_STATUS=$(registry_phone_status "$PHONE_ID")
    pass "Phone status changed to '$FINAL_STATUS' within ${ELAPSED}s"

    if [ "$FINAL_STATUS" = "disconnected" ]; then
        pass "Status is 'disconnected' (clean event-driven disconnect)"
    else
        observe "Status is '$FINAL_STATUS' (may be heartbeat-driven 'unreachable' rather than event-driven 'disconnected')"
    fi

    if [ "$ELAPSED" -le 5 ]; then
        pass "Disconnect latency within 5s target (${ELAPSED}s)"
    else
        observe "Disconnect took ${ELAPSED}s (target: 5s)"
        fail "disconnect_latency" "Took ${ELAPSED}s, target was 5s"
    fi
else
    FINAL_STATUS=$(registry_phone_status "$PHONE_ID")
    fail "phone_disconnect" "Phone still '$FINAL_STATUS' after 30s"
fi

finish_test "test_5bcd_phone_disconnect"
