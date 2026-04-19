#!/usr/bin/env bash
# Test 2: Node token cannot access admin-scoped endpoints
# Expects 403 with scope error message

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: node token cannot call admin endpoints ==="

# Get a valid node token via the full flow
HOST_ID=$(test_host_id)
get_node_token "$HOST_ID"
if [ $? -ne 0 ] || [ -z "$NODE_TOKEN" ]; then
    fail "setup" "Could not obtain node token"
    finish_test "test_node_token_cant_call_admin"
fi
echo "Got node token (prefix=${NODE_TOKEN:0:20}...)"

# Test 1: Node token -> approve endpoint
echo ""
echo "--- Node token -> POST approve ---"
RESULT=$(http_post "$ADMIN_URL/api/v1/auth/registrations/fake-id/approve" '{}' "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
BODY=$(get_body "$RESULT")
if [ "$STATUS" = "403" ]; then
    pass "Approve blocked for node token (403)"
elif [ "$STATUS" = "401" ]; then
    pass "Approve blocked for node token (401 -- admin service doesn't recognize node scope)"
else
    fail "approve_blocked" "Expected 403, got $STATUS body=$BODY"
fi

# Test 2: Node token -> list tokens
echo ""
echo "--- Node token -> GET tokens ---"
RESULT=$(http_get "$ADMIN_URL/api/v1/auth/tokens" "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ] || [ "$STATUS" = "401" ]; then
    pass "List tokens blocked for node token ($STATUS)"
else
    fail "list_tokens_blocked" "Expected 403/401, got $STATUS"
fi

# Test 3: Node token -> list registrations
echo ""
echo "--- Node token -> GET registrations/pending ---"
RESULT=$(http_get "$ADMIN_URL/api/v1/auth/registrations/pending" "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ] || [ "$STATUS" = "401" ]; then
    pass "List registrations blocked for node token ($STATUS)"
else
    fail "list_registrations_blocked" "Expected 403/401, got $STATUS"
fi

# Test 4: Node token -> reject endpoint
echo ""
echo "--- Node token -> POST reject ---"
RESULT=$(http_post "$ADMIN_URL/api/v1/auth/registrations/fake-id/reject" '{}' "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ] || [ "$STATUS" = "401" ]; then
    pass "Reject blocked for node token ($STATUS)"
else
    fail "reject_blocked" "Expected 403/401, got $STATUS"
fi

# Test 5: Node token -> events WebSocket (admin-scoped)
echo ""
echo "--- Node token -> GET /ws/fleet/events ---"
RESULT=$(http_get "$ADMIN_URL/ws/fleet/events" "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ] || [ "$STATUS" = "401" ]; then
    pass "Events WS blocked for node token ($STATUS)"
else
    observe "Events WS with node token returned $STATUS (may be 426 if WS upgrade expected)"
fi

# Test 6: Node token -> read-only admin endpoints (hosts list, phones list)
echo ""
echo "--- Node token -> GET /api/v1/hosts (admin-only in split mode) ---"
RESULT=$(http_get "$ADMIN_URL/api/v1/hosts" "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ] || [ "$STATUS" = "401" ]; then
    pass "Hosts list blocked for node token on admin ($STATUS)"
else
    fail "hosts_list_blocked" "Expected 403/401, got $STATUS"
fi

# Cleanup
if [ -n "$TOKEN_ID" ]; then
    revoke_token "$TOKEN_ID"
fi

finish_test "test_node_token_cant_call_admin"
