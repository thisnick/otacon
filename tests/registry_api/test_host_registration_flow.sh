#!/usr/bin/env bash
# Test: Host registration flow via new paths.
# POST /api/v1/hosts/register -> poll -> approve -> otc_node_* token

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: host registration flow ==="

HOST_ID=$(test_host_id)
echo "Using host_id=$HOST_ID"

# Step 1: Register host
echo ""
echo "--- Step 1: POST /api/v1/hosts/register ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/register" \
    "{\"host_id\": \"$HOST_ID\"}")
STATUS=$(get_status "$RESULT")
BODY=$(get_body "$RESULT")

if [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ]; then
    pass "Host registration accepted ($STATUS)"
else
    fail "host_register" "Expected 200/201, got $STATUS body=$BODY"
    finish_test "test_host_registration_flow"
fi

PENDING_ID=$(echo "$BODY" | jq -r '.pending_id // .id')
if [ -n "$PENDING_ID" ] && [ "$PENDING_ID" != "null" ]; then
    pass "Got pending_id=$PENDING_ID"
else
    fail "pending_id" "No pending_id in response: $BODY"
    finish_test "test_host_registration_flow"
fi

# Step 2: Verify pending shows in admin list
echo ""
echo "--- Step 2: GET /api/v1/admin/hosts/pending ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/hosts/pending" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
BODY=$(get_body "$RESULT")

if [ "$STATUS" = "200" ]; then
    FOUND=$(echo "$BODY" | jq -r --arg id "$PENDING_ID" '.[] | select(.id == $id) | .id')
    if [ "$FOUND" = "$PENDING_ID" ]; then
        pass "Pending host visible in admin list"
    else
        fail "pending_list" "Pending host $PENDING_ID not found in list: $BODY"
    fi
else
    fail "admin_hosts_pending" "Expected 200, got $STATUS"
fi

# Step 3: Start poll in background
echo ""
echo "--- Step 3: Poll for approval (background) ---"
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

# Step 4: Approve
echo ""
echo "--- Step 4: POST /api/v1/admin/hosts/{id}/approve ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/admin/hosts/$PENDING_ID/approve" \
    '{}' "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
BODY=$(get_body "$RESULT")
if [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ]; then
    pass "Host approved ($STATUS)"
else
    fail "host_approve" "Expected 200/201, got $STATUS body=$BODY"
    kill $POLL_PID 2>/dev/null || true
    finish_test "test_host_registration_flow"
fi

# Step 5: Wait for poll, verify token
echo ""
echo "--- Step 5: Poll receives token ---"
wait $POLL_PID 2>/dev/null || true
POLL_STATUS=$(cat "$POLL_STATUS_FILE" 2>/dev/null || echo "000")
POLL_BODY=$(cat "$POLL_TMPFILE" 2>/dev/null || echo "{}")
rm -f "$POLL_TMPFILE" "$POLL_STATUS_FILE"

if [ "$POLL_STATUS" = "200" ]; then
    NODE_TOKEN=$(echo "$POLL_BODY" | jq -r '.token // empty')
    if [ -n "$NODE_TOKEN" ]; then
        pass "Poll returned token"
    else
        fail "poll_token" "200 but no token in body: $POLL_BODY"
        finish_test "test_host_registration_flow"
    fi
else
    fail "poll_status" "Expected 200, got $POLL_STATUS body=$POLL_BODY"
    finish_test "test_host_registration_flow"
fi

# Step 6: Verify token prefix
echo ""
echo "--- Step 6: Token has otc_node_ prefix ---"
if [[ "$NODE_TOKEN" == otc_node_* ]]; then
    pass "Token prefix is otc_node_ (prefix=${NODE_TOKEN:0:20}...)"
else
    fail "token_prefix" "Expected otc_node_ prefix, got ${NODE_TOKEN:0:20}..."
fi

# Step 7: Use token for heartbeat
echo ""
echo "--- Step 7: Heartbeat with token ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Heartbeat accepted with node token"
else
    fail "heartbeat" "Expected 200, got $STATUS"
fi

# Cleanup: revoke token
TOKEN_ID=$(find_token_id "$NODE_TOKEN")
if [ -n "$TOKEN_ID" ] && [ "$TOKEN_ID" != "null" ]; then
    revoke_token "$TOKEN_ID"
fi

finish_test "test_host_registration_flow"
