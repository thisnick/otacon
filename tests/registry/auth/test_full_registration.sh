#!/usr/bin/env bash
# Test 1: Full registration lifecycle
# register -> admin approves -> poll receives token -> heartbeat -> revoke -> 401

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: full registration lifecycle ==="

HOST_ID=$(test_host_id)
echo "Using host_id=$HOST_ID"

# Step 1: Register
echo ""
echo "--- Step 1: Register node ---"
PENDING_ID=$(register_test_node "$HOST_ID")
if [ $? -ne 0 ]; then
    fail "register_node" "registration failed"
    finish_test "test_full_registration"
fi
pass "Registration accepted, pending_id=$PENDING_ID"

# Step 2: Start long-poll in background (POST, not GET)
echo ""
echo "--- Step 2: Poll for approval (background) ---"
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

# Step 3: Admin approves
echo ""
echo "--- Step 3: Admin approve ---"
APPROVE_RESULT=$(http_post "$ADMIN_URL/api/v1/auth/registrations/$PENDING_ID/approve" \
    '{}' "$ADMIN_TOKEN")
APPROVE_STATUS=$(get_status "$APPROVE_RESULT")
if [ "$APPROVE_STATUS" = "200" ] || [ "$APPROVE_STATUS" = "201" ]; then
    pass "Admin approved registration"
else
    fail "admin_approve" "status=$APPROVE_STATUS body=$(get_body "$APPROVE_RESULT")"
    kill $POLL_PID 2>/dev/null || true
    finish_test "test_full_registration"
fi

# Step 4: Wait for poll to complete
echo ""
echo "--- Step 4: Poll receives token ---"
wait $POLL_PID 2>/dev/null || true
POLL_STATUS=$(cat "$POLL_STATUS_FILE" 2>/dev/null || echo "000")
POLL_BODY=$(cat "$POLL_TMPFILE" 2>/dev/null || echo "{}")
rm -f "$POLL_TMPFILE" "$POLL_STATUS_FILE"

if [ "$POLL_STATUS" = "200" ]; then
    NODE_TOKEN=$(echo "$POLL_BODY" | jq -r '.token // empty')
    if [ -n "$NODE_TOKEN" ]; then
        pass "Poll received token (prefix=${NODE_TOKEN:0:20}...)"
    else
        fail "poll_token" "200 but no token in body: $POLL_BODY"
        finish_test "test_full_registration"
    fi
else
    fail "poll_status" "Expected 200, got $POLL_STATUS body=$POLL_BODY"
    finish_test "test_full_registration"
fi

# Step 5: Use token for heartbeat
echo ""
echo "--- Step 5: Heartbeat with token ---"
HB_RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
    "$NODE_TOKEN")
HB_STATUS=$(get_status "$HB_RESULT")
if [ "$HB_STATUS" = "200" ]; then
    pass "Heartbeat accepted with valid token"
else
    fail "heartbeat" "status=$HB_STATUS"
fi

# Step 6: Find token_id via admin API and revoke
echo ""
echo "--- Step 6: Revoke token ---"
TOKEN_ID=$(find_token_id "$NODE_TOKEN")
if [ -n "$TOKEN_ID" ] && [ "$TOKEN_ID" != "null" ]; then
    REVOKE_RESULT=$(http_post "$ADMIN_URL/api/v1/auth/tokens/$TOKEN_ID/revoke" \
        '{}' "$ADMIN_TOKEN")
    REVOKE_STATUS=$(get_status "$REVOKE_RESULT")
    if [ "$REVOKE_STATUS" = "200" ]; then
        pass "Token revoked"
    else
        fail "revoke_token" "status=$REVOKE_STATUS"
    fi
else
    fail "revoke_token" "Could not find token_id via admin API"
fi

# Step 7: Use revoked token -> expect 401
echo ""
echo "--- Step 7: Revoked token rejected ---"
HB_RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
    "$NODE_TOKEN")
HB_STATUS=$(get_status "$HB_RESULT")
if [ "$HB_STATUS" = "401" ]; then
    pass "Revoked token correctly rejected (401)"
else
    fail "revoked_token" "Expected 401, got $HB_STATUS"
fi

finish_test "test_full_registration"
