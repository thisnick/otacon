#!/usr/bin/env bash
# Test 3: Admin token cannot access node-scoped endpoints on registry
# Expects 403 with scope error message

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: admin token cannot call node-scoped endpoints ==="

# Test 1: Admin token -> heartbeat on registry
echo ""
echo "--- Admin token -> POST heartbeat ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    '{"host_id": "admin-scope-test", "phones": [], "dongles": []}' \
    "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ]; then
    pass "Heartbeat blocked for admin token (403)"
else
    fail "heartbeat_blocked" "Expected 403, got $STATUS"
fi

# Test 2: Admin token -> host register on registry
echo ""
echo "--- Admin token -> POST host register ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/register" \
    '{"id": "admin-scope-test"}' \
    "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ]; then
    pass "Host register blocked for admin token (403)"
else
    fail "host_register_blocked" "Expected 403, got $STATUS"
fi

# Test 3: Admin token -> phone register on registry
echo ""
echo "--- Admin token -> POST phone register ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/phones/register" \
    '{"host_id": "admin-scope-test", "id": "phone-scope-test", "adb_serial": "FAKE123"}' \
    "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ]; then
    pass "Phone register blocked for admin token (403)"
else
    fail "phone_register_blocked" "Expected 403, got $STATUS"
fi

# Test 4: Admin token -> dongle register on registry
echo ""
echo "--- Admin token -> POST dongle register ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/dongles/register" \
    '{"host_id": "admin-scope-test", "dongles": []}' \
    "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ]; then
    pass "Dongle register blocked for admin token (403)"
else
    fail "dongle_register_blocked" "Expected 403, got $STATUS"
fi

# Test 5: Admin token -> host config WebSocket on registry
echo ""
echo "--- Admin token -> GET /ws/host/config ---"
RESULT=$(http_get "$REGISTRY_URL/ws/host/config" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ] || [ "$STATUS" = "401" ]; then
    pass "Host config WS blocked for admin token ($STATUS)"
else
    observe "Host config WS with admin token returned $STATUS (may be 426 if WS upgrade expected)"
fi

finish_test "test_admin_token_cant_call_node"
