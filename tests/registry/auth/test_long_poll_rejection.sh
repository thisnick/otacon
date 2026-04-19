#!/usr/bin/env bash
# Test 13: Long-poll rejection
# Register, admin rejects, verify long-poll returns 403

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: long-poll rejection ==="

HOST_ID=$(test_host_id)

# Register
PENDING_ID=$(register_test_node "$HOST_ID")
if [ $? -ne 0 ]; then
    fail "register" "registration failed"
    finish_test "test_long_poll_rejection"
fi
pass "Registered, pending_id=$PENDING_ID"

# Start poll in background
echo ""
echo "--- Polling (background) ---"
POLL_TMPFILE=$(mktemp)
POLL_STATUS_FILE=$(mktemp)
(
    status=$(curl -s -o "$POLL_TMPFILE" -w '%{http_code}' \
        -X POST --max-time 30 \
        "$REGISTRY_URL/api/v1/auth/poll/$PENDING_ID" 2>/dev/null) || status="000"
    echo "$status" > "$POLL_STATUS_FILE"
) &
POLL_PID=$!
sleep 2

# Admin rejects
echo ""
echo "--- Admin rejecting registration ---"
REJECT_RESULT=$(http_post "$ADMIN_URL/api/v1/auth/registrations/$PENDING_ID/reject" \
    '{}' "$ADMIN_TOKEN")
REJECT_STATUS=$(get_status "$REJECT_RESULT")
if [ "$REJECT_STATUS" = "200" ] || [ "$REJECT_STATUS" = "201" ]; then
    pass "Admin rejected registration"
else
    fail "admin_reject" "status=$REJECT_STATUS body=$(get_body "$REJECT_RESULT")"
fi

# Wait for poll to complete
wait $POLL_PID 2>/dev/null || true
POLL_STATUS=$(cat "$POLL_STATUS_FILE" 2>/dev/null || echo "000")
POLL_BODY=$(cat "$POLL_TMPFILE" 2>/dev/null || echo "")
rm -f "$POLL_TMPFILE" "$POLL_STATUS_FILE"

echo ""
echo "--- Poll result ---"
if [ "$POLL_STATUS" = "403" ]; then
    pass "Poll returned 403 on rejection"
elif [ "$POLL_STATUS" = "200" ]; then
    # Check if the body indicates rejection
    REJECTED=$(echo "$POLL_BODY" | jq -r '.status // .state // empty' 2>/dev/null)
    if [ "$REJECTED" = "rejected" ]; then
        observe "Poll returned 200 with status=rejected (not 403, but functional)"
    else
        fail "poll_rejection" "Poll returned 200 without rejection indicator: $POLL_BODY"
    fi
else
    fail "poll_rejection" "Expected 403, got $POLL_STATUS body=$POLL_BODY"
fi

finish_test "test_long_poll_rejection"
