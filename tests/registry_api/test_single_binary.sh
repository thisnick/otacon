#!/usr/bin/env bash
# Test: Registry runs as a single binary/port serving both node and admin routes.
# The old dual-mode (OTACON_SERVICE_MODE=registry|admin) should be merged.

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: single binary serves both node and admin ==="

# Both public registration and admin endpoints should be on the same URL/port.

echo ""
echo "--- Public endpoint on registry port ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/register" '{"host_id":"single-binary-test"}')
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ]; then
    pass "Public endpoint (hosts/register) responds on registry port"
    PENDING_ID=$(get_body "$RESULT" | jq -r '.pending_id // empty')
else
    fail "public_endpoint" "Expected 200/201, got $STATUS"
fi

echo ""
echo "--- Admin endpoint on same port ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/phones" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Admin endpoint (admin/phones) responds on same registry port"
else
    fail "admin_endpoint" "Expected 200, got $STATUS"
fi

echo ""
echo "--- Node-authed endpoint on same port ---"
# We need a node token to test this
HOST_ID=$(test_host_id)
get_node_token "$HOST_ID"
if [ $? -eq 0 ] && [ -n "$NODE_TOKEN" ]; then
    RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
        "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
        "$NODE_TOKEN")
    STATUS=$(get_status "$RESULT")
    if [ "$STATUS" = "200" ]; then
        pass "Node-authed endpoint (heartbeat) responds on same registry port"
    else
        fail "node_endpoint" "Expected 200, got $STATUS"
    fi

    # Cleanup
    TOKEN_ID=$(find_token_id "$NODE_TOKEN")
    if [ -n "$TOKEN_ID" ] && [ "$TOKEN_ID" != "null" ]; then
        revoke_token "$TOKEN_ID"
    fi
else
    observe "Could not obtain node token for single-binary test"
fi

# Clean up the pending registration we created
if [ -n "$PENDING_ID" ] && [ "$PENDING_ID" != "null" ]; then
    http_post "$REGISTRY_URL/api/v1/admin/hosts/$PENDING_ID/reject" '{}' "$ADMIN_TOKEN" >/dev/null 2>&1
fi

finish_test "test_single_binary"
