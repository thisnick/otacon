#!/usr/bin/env bash
# Test: Admin DELETE /api/v1/admin/hosts/{id}
# Verifies "forget" semantics for hosts.

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: admin DELETE host ==="

# Setup: get a node token and create a host via heartbeat
HOST_ID=$(test_host_id)
echo "Setup: obtaining node token for host_id=$HOST_ID..."
get_node_token "$HOST_ID"
if [ $? -ne 0 ] || [ -z "$NODE_TOKEN" ]; then
    fail "setup_node_token" "Could not obtain node token"
    finish_test "test_admin_delete_host"
fi

# Heartbeat to create host entry in store
http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
    "$NODE_TOKEN" >/dev/null

# Verify host exists
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/hosts" "$ADMIN_TOKEN")
FOUND=$(get_body "$RESULT" | jq -r --arg id "$HOST_ID" '[.[] | select(.id == $id)] | length')
if [ "$FOUND" -ge 1 ]; then
    pass "Host $HOST_ID created via heartbeat"
else
    fail "host_created" "Host $HOST_ID not found after heartbeat"
    finish_test "test_admin_delete_host"
fi

# --- Test 1: DELETE the host via admin endpoint ---
echo ""
echo "--- DELETE /api/v1/admin/hosts/$HOST_ID ---"
RESULT=$(http_delete "$REGISTRY_URL/api/v1/admin/hosts/$HOST_ID" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "DELETE host -> 200"
else
    fail "delete_host" "Expected 200, got $STATUS"
fi

# --- Test 2: Confirm host returns 404 ---
echo ""
echo "--- GET /api/v1/admin/hosts/$HOST_ID (should be 404) ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/hosts/$HOST_ID" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "404" ]; then
    pass "Host detail after delete -> 404"
else
    fail "host_404_after_delete" "Expected 404, got $STATUS"
fi

# --- Test 3: Host absent from list ---
echo ""
echo "--- GET /api/v1/admin/hosts (host should be absent) ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/hosts" "$ADMIN_TOKEN")
FOUND=$(get_body "$RESULT" | jq -r --arg id "$HOST_ID" '[.[] | select(.id == $id)] | length')
if [ "$FOUND" = "0" ]; then
    pass "Host absent from list after delete"
else
    fail "host_still_in_list" "Host $HOST_ID still in list after delete"
fi

# --- Test 4: Double-delete returns 404 ---
echo ""
echo "--- DELETE /api/v1/admin/hosts/$HOST_ID (double delete, should 404) ---"
RESULT=$(http_delete "$REGISTRY_URL/api/v1/admin/hosts/$HOST_ID" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "404" ]; then
    pass "Double delete -> 404"
else
    fail "double_delete" "Expected 404, got $STATUS"
fi

# --- Test 5: Re-register via heartbeat (forget semantics) ---
echo ""
echo "--- Re-register host via heartbeat (forget semantics) ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Heartbeat after host delete -> 200"
else
    fail "heartbeat_after_delete" "Expected 200, got $STATUS"
fi

# Confirm it's back
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/hosts" "$ADMIN_TOKEN")
FOUND=$(get_body "$RESULT" | jq -r --arg id "$HOST_ID" '[.[] | select(.id == $id)] | length')
if [ "$FOUND" -ge 1 ]; then
    pass "Host reappears in list after heartbeat re-registration"
else
    fail "host_reappears" "Host not found in list after heartbeat"
fi

# --- Test 6: Auth required ---
echo ""
echo "--- DELETE without auth (should 401) ---"
RESULT=$(http_delete "$REGISTRY_URL/api/v1/admin/hosts/$HOST_ID")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "401" ]; then
    pass "Delete without auth -> 401"
else
    fail "delete_no_auth" "Expected 401, got $STATUS"
fi

# Cleanup: delete host, revoke node token
http_delete "$REGISTRY_URL/api/v1/admin/hosts/$HOST_ID" "$ADMIN_TOKEN" >/dev/null 2>&1
TOKEN_ID=$(find_token_id "$NODE_TOKEN")
if [ -n "$TOKEN_ID" ] && [ "$TOKEN_ID" != "null" ]; then
    revoke_token "$TOKEN_ID"
fi

finish_test "test_admin_delete_host"
