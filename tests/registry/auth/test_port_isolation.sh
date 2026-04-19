#!/usr/bin/env bash
# Test 9: Service isolation between registry and admin
# - Node token works on registry (otacon-registry:9080, own tailnet identity)
# - Node token is rejected on admin (Pi host:9090, different service + scope)

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: port / service isolation ==="

# Get a valid node token
HOST_ID=$(test_host_id)
get_node_token "$HOST_ID"
if [ $? -ne 0 ] || [ -z "$NODE_TOKEN" ]; then
    fail "setup" "Could not obtain node token"
    finish_test "test_port_isolation"
fi

# Test 1: Node token works on registry (port 9080)
echo ""
echo "--- Node token on registry (9080) ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Node token accepted on registry:9080"
else
    fail "node_on_registry" "Expected 200, got $STATUS"
fi

# Test 2: Node token rejected on admin (port 9090)
echo ""
echo "--- Node token on admin (9090) ---"
RESULT=$(http_get "$ADMIN_URL/api/v1/auth/tokens" "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ] || [ "$STATUS" = "401" ]; then
    pass "Node token rejected on admin:9090 ($STATUS)"
else
    fail "node_on_admin" "Expected 403/401, got $STATUS"
fi

# Test 3: Admin token works on admin (port 9090)
echo ""
echo "--- Admin token on admin (9090) ---"
RESULT=$(http_get "$ADMIN_URL/api/v1/auth/tokens" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Admin token accepted on admin:9090"
else
    fail "admin_on_admin" "Expected 200, got $STATUS"
fi

# Test 4: Admin token rejected on registry (port 9080) for node endpoints
echo ""
echo "--- Admin token on registry (9080) ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    '{"host_id": "admin-port-test", "phones": [], "dongles": []}' \
    "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ]; then
    pass "Admin token rejected on registry:9080 for node endpoints (403)"
else
    fail "admin_on_registry" "Expected 403, got $STATUS"
fi

# Cleanup
if [ -n "$TOKEN_ID" ]; then
    revoke_token "$TOKEN_ID"
fi

finish_test "test_port_isolation"
