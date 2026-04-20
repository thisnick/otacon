#!/usr/bin/env bash
# Test: Admin DELETE /api/v1/admin/phones/{id}
# Verifies "forget" semantics: delete phone, confirm 404, heartbeat re-registers.

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: admin DELETE phone ==="

# Setup: get a node token and register a test phone
HOST_ID=$(test_host_id)
echo "Setup: obtaining node token for host_id=$HOST_ID..."
get_node_token "$HOST_ID"
if [ $? -ne 0 ] || [ -z "$NODE_TOKEN" ]; then
    fail "setup_node_token" "Could not obtain node token"
    finish_test "test_admin_delete_phone"
fi

ADB_SERIAL="DEL_TEST_$(date +%s)"

# Heartbeat to create host entry
http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
    "$NODE_TOKEN" >/dev/null

# Register a phone
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/phones/register" \
    "{\"host_id\": \"$HOST_ID\", \"adb_serial\": \"$ADB_SERIAL\", \"model\": \"SM-Del-Test\", \"phone_number\": \"+15550001\"}" \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" != "200" ] && [ "$STATUS" != "201" ]; then
    fail "register_phone" "Phone registration failed: status=$STATUS"
    finish_test "test_admin_delete_phone"
fi

# Find the phone ID from admin list
PHONES_RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/phones" "$ADMIN_TOKEN")
PHONE_ID=$(get_body "$PHONES_RESULT" | jq -r --arg serial "$ADB_SERIAL" \
    '[.[] | select(.adb_serial == $serial)] | first | .id // empty')
if [ -z "$PHONE_ID" ]; then
    fail "find_phone" "Could not find registered phone with adb_serial=$ADB_SERIAL"
    finish_test "test_admin_delete_phone"
fi
observe "Registered phone: $PHONE_ID"

# --- Test 1: DELETE the phone via admin endpoint ---
echo ""
echo "--- DELETE /api/v1/admin/phones/$PHONE_ID ---"
RESULT=$(http_delete "$REGISTRY_URL/api/v1/admin/phones/$PHONE_ID" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "DELETE phone -> 200"
else
    fail "delete_phone" "Expected 200, got $STATUS"
fi

# --- Test 2: Confirm phone returns 404 ---
echo ""
echo "--- GET /api/v1/admin/phones/$PHONE_ID (should be 404) ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/phones/$PHONE_ID" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "404" ]; then
    pass "Phone detail after delete -> 404"
else
    fail "phone_404_after_delete" "Expected 404, got $STATUS"
fi

# --- Test 3: Phone absent from list ---
echo ""
echo "--- GET /api/v1/admin/phones (phone should be absent) ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/phones" "$ADMIN_TOKEN")
FOUND=$(get_body "$RESULT" | jq -r --arg id "$PHONE_ID" '[.[] | select(.id == $id)] | length')
if [ "$FOUND" = "0" ]; then
    pass "Phone absent from list after delete"
else
    fail "phone_still_in_list" "Phone $PHONE_ID still in list after delete"
fi

# --- Test 4: Double-delete returns 404 ---
echo ""
echo "--- DELETE /api/v1/admin/phones/$PHONE_ID (double delete, should 404) ---"
RESULT=$(http_delete "$REGISTRY_URL/api/v1/admin/phones/$PHONE_ID" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "404" ]; then
    pass "Double delete -> 404"
else
    fail "double_delete" "Expected 404, got $STATUS"
fi

# --- Test 5: Re-register via heartbeat (forget semantics) ---
echo ""
echo "--- Re-register phone via phones/register (heartbeat re-creates) ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/phones/register" \
    "{\"host_id\": \"$HOST_ID\", \"adb_serial\": \"$ADB_SERIAL\", \"model\": \"SM-Del-Test\", \"phone_number\": \"+15550001\"}" \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ]; then
    pass "Re-register phone after delete -> $STATUS"
else
    fail "reregister_phone" "Expected 200/201, got $STATUS"
fi

# Confirm it's back in the list
PHONES_RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/phones" "$ADMIN_TOKEN")
FOUND=$(get_body "$PHONES_RESULT" | jq -r --arg serial "$ADB_SERIAL" \
    '[.[] | select(.adb_serial == $serial)] | length')
if [ "$FOUND" -ge 1 ]; then
    pass "Phone reappears in list after re-registration"
else
    fail "phone_reappears" "Phone not found in list after re-registration"
fi

# --- Test 6: Auth required ---
echo ""
echo "--- DELETE without auth (should 401) ---"
RESULT=$(http_delete "$REGISTRY_URL/api/v1/admin/phones/$PHONE_ID")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "401" ]; then
    pass "Delete without auth -> 401"
else
    fail "delete_no_auth" "Expected 401, got $STATUS"
fi

# Cleanup: remove re-registered phone, revoke token
NEW_PHONE_ID=$(get_body "$PHONES_RESULT" | jq -r --arg serial "$ADB_SERIAL" \
    '[.[] | select(.adb_serial == $serial)] | first | .id // empty')
if [ -n "$NEW_PHONE_ID" ]; then
    http_delete "$REGISTRY_URL/api/v1/hosts/phones/$NEW_PHONE_ID" "$NODE_TOKEN" >/dev/null 2>&1
fi
TOKEN_ID=$(find_token_id "$NODE_TOKEN")
if [ -n "$TOKEN_ID" ] && [ "$TOKEN_ID" != "null" ]; then
    revoke_token "$TOKEN_ID"
fi

finish_test "test_admin_delete_phone"
