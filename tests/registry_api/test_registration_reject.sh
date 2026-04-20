#!/usr/bin/env bash
# Test: Host and client registration rejection via new paths.

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: registration rejection ==="

# --- Host rejection ---
echo ""
echo "--- Host rejection ---"
HOST_ID=$(test_host_id)
PENDING_ID=$(register_test_host "$HOST_ID")
if [ $? -ne 0 ]; then
    fail "host_register" "Could not register test host"
    finish_test "test_registration_reject"
fi

# Start poll in background
POLL_TMPFILE=$(mktemp)
POLL_STATUS_FILE=$(mktemp)
(
    st=$(curl -s -o "$POLL_TMPFILE" -w '%{http_code}' \
        -X POST --max-time 30 \
        "$REGISTRY_URL/api/v1/hosts/poll/$PENDING_ID" 2>/dev/null) || st="000"
    echo "$st" > "$POLL_STATUS_FILE"
) &
POLL_PID=$!
sleep 2

# Reject
RESULT=$(http_post "$REGISTRY_URL/api/v1/admin/hosts/$PENDING_ID/reject" \
    '{}' "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Host rejection accepted"
else
    fail "host_reject" "Expected 200, got $STATUS"
fi

# Poll should return 403 (rejected)
wait $POLL_PID 2>/dev/null || true
POLL_STATUS=$(cat "$POLL_STATUS_FILE" 2>/dev/null || echo "000")
rm -f "$POLL_TMPFILE" "$POLL_STATUS_FILE"
if [ "$POLL_STATUS" = "403" ]; then
    pass "Host poll returns 403 on rejection"
else
    observe "Host poll returned $POLL_STATUS on rejection (expected 403)"
fi

# --- Client rejection ---
echo ""
echo "--- Client rejection ---"
CLIENT_ID="test-client-reject-$(date +%s)-$$"
PENDING_ID=$(register_test_client "$CLIENT_ID")
if [ $? -ne 0 ]; then
    fail "client_register" "Could not register test client"
    finish_test "test_registration_reject"
fi

RESULT=$(http_post "$REGISTRY_URL/api/v1/admin/clients/$PENDING_ID/reject" \
    '{}' "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Client rejection accepted"
else
    fail "client_reject" "Expected 200, got $STATUS"
fi

finish_test "test_registration_reject"
