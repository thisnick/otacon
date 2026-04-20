#!/usr/bin/env bash
# Test: Admin DELETE /api/v1/admin/dongles/{id}
# Verifies "forget" semantics for dongles.

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: admin DELETE dongle ==="

# Setup: get a node token and register a dongle
HOST_ID=$(test_host_id)
echo "Setup: obtaining node token for host_id=$HOST_ID..."
get_node_token "$HOST_ID"
if [ $? -ne 0 ] || [ -z "$NODE_TOKEN" ]; then
    fail "setup_node_token" "Could not obtain node token"
    finish_test "test_admin_delete_dongle"
fi

# Heartbeat to create host entry
http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
    "$NODE_TOKEN" >/dev/null

# Register a dongle with a unique MAC
DONGLE_MAC="AA:BB:CC:DD:$(printf '%02X' $((RANDOM % 256))):$(printf '%02X' $((RANDOM % 256)))"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/dongles/register" \
    "{\"host_id\": \"$HOST_ID\", \"dongles\": [{\"bt_mac\": \"$DONGLE_MAC\"}]}" \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" != "200" ]; then
    fail "register_dongle" "Dongle registration failed: status=$STATUS"
    finish_test "test_admin_delete_dongle"
fi

# Find the dongle ID from admin list
DONGLES_RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/dongles" "$ADMIN_TOKEN")
MAC_LOWER=$(echo "$DONGLE_MAC" | tr '[:upper:]' '[:lower:]')
DONGLE_ID=$(get_body "$DONGLES_RESULT" | jq -r --arg mac "$MAC_LOWER" \
    '[.[] | select(.bt_mac | ascii_downcase == $mac)] | first | .id // empty')
if [ -z "$DONGLE_ID" ]; then
    # Try without lowering (server may store as-is)
    DONGLE_ID=$(get_body "$DONGLES_RESULT" | jq -r --arg mac "$DONGLE_MAC" \
        '[.[] | select(.bt_mac == $mac)] | first | .id // empty')
fi
if [ -z "$DONGLE_ID" ]; then
    fail "find_dongle" "Could not find registered dongle with bt_mac=$DONGLE_MAC"
    observe "Dongles in registry: $(get_body "$DONGLES_RESULT" | jq -r '.[].bt_mac')"
    finish_test "test_admin_delete_dongle"
fi
observe "Registered dongle: $DONGLE_ID"

# --- Test 1: DELETE the dongle ---
echo ""
echo "--- DELETE /api/v1/admin/dongles/$DONGLE_ID ---"
RESULT=$(http_delete "$REGISTRY_URL/api/v1/admin/dongles/$DONGLE_ID" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "DELETE dongle -> 200"
else
    fail "delete_dongle" "Expected 200, got $STATUS"
fi

# --- Test 2: Dongle absent from list ---
echo ""
echo "--- GET /api/v1/admin/dongles (dongle should be absent) ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/dongles" "$ADMIN_TOKEN")
FOUND=$(get_body "$RESULT" | jq -r --arg id "$DONGLE_ID" '[.[] | select(.id == $id)] | length')
if [ "$FOUND" = "0" ]; then
    pass "Dongle absent from list after delete"
else
    fail "dongle_still_in_list" "Dongle $DONGLE_ID still in list after delete"
fi

# --- Test 3: Double-delete returns 404 ---
echo ""
echo "--- DELETE /api/v1/admin/dongles/$DONGLE_ID (double delete, should 404) ---"
RESULT=$(http_delete "$REGISTRY_URL/api/v1/admin/dongles/$DONGLE_ID" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "404" ]; then
    pass "Double delete -> 404"
else
    fail "double_delete" "Expected 404, got $STATUS"
fi

# --- Test 4: Re-register via dongles/register (forget semantics) ---
echo ""
echo "--- Re-register dongle after delete ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/dongles/register" \
    "{\"host_id\": \"$HOST_ID\", \"dongles\": [{\"bt_mac\": \"$DONGLE_MAC\"}]}" \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Re-register dongle after delete -> 200"
else
    fail "reregister_dongle" "Expected 200, got $STATUS"
fi

RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/dongles" "$ADMIN_TOKEN")
FOUND=$(get_body "$RESULT" | jq -r --arg mac "$MAC_LOWER" \
    '[.[] | select(.bt_mac | ascii_downcase == $mac)] | length')
if [ "$FOUND" = "0" ]; then
    FOUND=$(get_body "$RESULT" | jq -r --arg mac "$DONGLE_MAC" \
        '[.[] | select(.bt_mac == $mac)] | length')
fi
if [ "$FOUND" -ge 1 ]; then
    pass "Dongle reappears in list after re-registration"
else
    fail "dongle_reappears" "Dongle not found in list after re-registration"
fi

# Cleanup: delete re-registered dongle, delete host, revoke token
NEW_DONGLE_ID=$(get_body "$RESULT" | jq -r --arg mac "$MAC_LOWER" \
    '[.[] | select(.bt_mac | ascii_downcase == $mac)] | first | .id // empty')
if [ -n "$NEW_DONGLE_ID" ]; then
    http_delete "$REGISTRY_URL/api/v1/admin/dongles/$NEW_DONGLE_ID" "$ADMIN_TOKEN" >/dev/null 2>&1
fi
http_delete "$REGISTRY_URL/api/v1/admin/hosts/$HOST_ID" "$ADMIN_TOKEN" >/dev/null 2>&1
TOKEN_ID=$(find_token_id "$NODE_TOKEN")
if [ -n "$TOKEN_ID" ] && [ "$TOKEN_ID" != "null" ]; then
    revoke_token "$TOKEN_ID"
fi

finish_test "test_admin_delete_dongle"
