#!/usr/bin/env bash
# Test 12: Long-poll timeout
# Register, never approve, verify long-poll returns 408 after expected timeout window

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps

echo "=== Test: long-poll timeout ==="

HOST_ID=$(test_host_id)

# Register
PENDING_ID=$(register_test_node "$HOST_ID")
if [ $? -ne 0 ]; then
    fail "register" "registration failed"
    finish_test "test_long_poll_timeout"
fi
pass "Registered, pending_id=$PENDING_ID"

# Poll and DON'T approve -- expect 408
echo ""
echo "--- Polling without approval (waiting for server timeout) ---"
echo "    This may take up to 60 seconds..."

START_TIME=$(date +%s)
TMPFILE=$(mktemp)
STATUS=$(curl -s -o "$TMPFILE" -w '%{http_code}' \
    -X POST --max-time 120 \
    "$REGISTRY_URL/api/v1/auth/poll/$PENDING_ID" 2>/dev/null) || STATUS="000"
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
BODY=$(cat "$TMPFILE" 2>/dev/null)
rm -f "$TMPFILE"

echo "  Server responded after ${ELAPSED}s with status=$STATUS"

if [ "$STATUS" = "408" ]; then
    pass "Long-poll timed out with 408 after ${ELAPSED}s"
elif [ "$STATUS" = "000" ]; then
    fail "poll_timeout" "Client timed out (120s) before server returned -- server may not enforce timeout"
elif [ "$STATUS" = "200" ]; then
    fail "poll_timeout" "Got 200 without approval -- possible bug, body=$BODY"
else
    observe "Unexpected status=$STATUS after ${ELAPSED}s body=$BODY"
fi

# Cleanup if possible
if [ -n "$ADMIN_TOKEN" ]; then
    http_post "$ADMIN_URL/api/v1/auth/registrations/$PENDING_ID/reject" \
        '{}' "$ADMIN_TOKEN" >/dev/null 2>&1 || true
fi

finish_test "test_long_poll_timeout"
