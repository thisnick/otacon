#!/usr/bin/env bash
# Test: Client registration flow via new paths.
# POST /api/v1/clients/register -> poll -> approve -> otc_admin_* token

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: client registration flow ==="

CLIENT_ID="test-client-$(date +%s)-$$"
echo "Using client_id=$CLIENT_ID"

# Step 1: Register client
echo ""
echo "--- Step 1: POST /api/v1/clients/register ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/clients/register" \
    "{\"client_id\": \"$CLIENT_ID\"}")
STATUS=$(get_status "$RESULT")
BODY=$(get_body "$RESULT")

if [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ]; then
    pass "Client registration accepted ($STATUS)"
else
    fail "client_register" "Expected 200/201, got $STATUS body=$BODY"
    finish_test "test_client_registration_flow"
fi

PENDING_ID=$(echo "$BODY" | jq -r '.pending_id // .id')
if [ -n "$PENDING_ID" ] && [ "$PENDING_ID" != "null" ]; then
    pass "Got pending_id=$PENDING_ID"
else
    fail "pending_id" "No pending_id in response: $BODY"
    finish_test "test_client_registration_flow"
fi

# Step 2: Verify pending shows in admin list for clients
echo ""
echo "--- Step 2: GET /api/v1/admin/clients/pending ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/clients/pending" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
BODY=$(get_body "$RESULT")

if [ "$STATUS" = "200" ]; then
    FOUND=$(echo "$BODY" | jq -r --arg id "$PENDING_ID" '.[] | select(.id == $id) | .id')
    if [ "$FOUND" = "$PENDING_ID" ]; then
        pass "Pending client visible in admin list"
    else
        fail "pending_list" "Pending client $PENDING_ID not found in list: $BODY"
    fi
else
    fail "admin_clients_pending" "Expected 200, got $STATUS"
fi

# Step 3: Poll in background
echo ""
echo "--- Step 3: Poll for approval (background) ---"
POLL_TMPFILE=$(mktemp)
POLL_STATUS_FILE=$(mktemp)
(
    st=$(curl -s -o "$POLL_TMPFILE" -w '%{http_code}' \
        -X POST --max-time 30 \
        "$REGISTRY_URL/api/v1/clients/poll/$PENDING_ID" 2>/dev/null) || st="000"
    echo "$st" > "$POLL_STATUS_FILE"
) &
POLL_PID=$!
sleep 2

# Step 4: Approve client
echo ""
echo "--- Step 4: POST /api/v1/admin/clients/{id}/approve ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/admin/clients/$PENDING_ID/approve" \
    '{}' "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
BODY=$(get_body "$RESULT")
if [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ]; then
    pass "Client approved ($STATUS)"
else
    fail "client_approve" "Expected 200/201, got $STATUS body=$BODY"
    kill $POLL_PID 2>/dev/null || true
    finish_test "test_client_registration_flow"
fi

# Step 5: Poll receives token
echo ""
echo "--- Step 5: Poll receives token ---"
wait $POLL_PID 2>/dev/null || true
POLL_STATUS=$(cat "$POLL_STATUS_FILE" 2>/dev/null || echo "000")
POLL_BODY=$(cat "$POLL_TMPFILE" 2>/dev/null || echo "{}")
rm -f "$POLL_TMPFILE" "$POLL_STATUS_FILE"

if [ "$POLL_STATUS" = "200" ]; then
    CLIENT_TOKEN=$(echo "$POLL_BODY" | jq -r '.token // empty')
    if [ -n "$CLIENT_TOKEN" ]; then
        pass "Poll returned token"
    else
        fail "poll_token" "200 but no token in body: $POLL_BODY"
        finish_test "test_client_registration_flow"
    fi
else
    fail "poll_status" "Expected 200, got $POLL_STATUS body=$POLL_BODY"
    finish_test "test_client_registration_flow"
fi

# Step 6: Verify token prefix is otc_admin_*
echo ""
echo "--- Step 6: Token has otc_admin_ prefix ---"
if [[ "$CLIENT_TOKEN" == otc_admin_* ]]; then
    pass "Token prefix is otc_admin_ (prefix=${CLIENT_TOKEN:0:20}...)"
else
    fail "token_prefix" "Expected otc_admin_ prefix, got ${CLIENT_TOKEN:0:20}..."
fi

# Step 7: Use admin token to call an admin endpoint
echo ""
echo "--- Step 7: Client token can call admin endpoints ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/phones" "$CLIENT_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Client token accepted on admin endpoint ($STATUS)"
else
    fail "admin_access" "Expected 200, got $STATUS"
fi

# Step 8: Client token should NOT work on node endpoints
echo ""
echo "--- Step 8: Client token rejected on node endpoints ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    '{"host_id":"fake","phones":[],"dongles":[]}' "$CLIENT_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ]; then
    pass "Client token rejected on node endpoint (403)"
elif [ "$STATUS" = "401" ]; then
    pass "Client token rejected on node endpoint (401)"
else
    fail "node_scope_blocked" "Expected 403/401, got $STATUS"
fi

# Cleanup
TOKEN_ID=$(find_token_id "$CLIENT_TOKEN")
if [ -n "$TOKEN_ID" ] && [ "$TOKEN_ID" != "null" ]; then
    revoke_token "$TOKEN_ID"
fi

finish_test "test_client_registration_flow"
