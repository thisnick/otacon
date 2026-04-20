#!/usr/bin/env bash
# Test: All new node-scope paths respond correctly under /api/v1/hosts/...
# Requires a valid node token.

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: new node-scope paths ==="

HOST_ID=$(test_host_id)
echo "Obtaining node token for host_id=$HOST_ID..."
get_node_token "$HOST_ID"
if [ $? -ne 0 ] || [ -z "$NODE_TOKEN" ]; then
    fail "setup" "Could not obtain node token"
    finish_test "test_new_node_scope_paths"
fi
echo "Got node token (prefix=${NODE_TOKEN:0:20}...)"

# --- POST /api/v1/hosts/heartbeat ---
echo ""
echo "--- POST /api/v1/hosts/heartbeat ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Heartbeat accepted"
else
    fail "heartbeat" "Expected 200, got $STATUS"
fi

# --- POST /api/v1/hosts/phones/register ---
echo ""
echo "--- POST /api/v1/hosts/phones/register ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/phones/register" \
    "{\"host_id\": \"$HOST_ID\", \"adb_serial\": \"TEST_SERIAL_$(date +%s)\", \"model\": \"TestPhone\", \"phone_number\": \"+15550001\"}" \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
BODY=$(get_body "$RESULT")
if [ "$STATUS" = "200" ]; then
    PHONE_ID=$(echo "$BODY" | jq -r '.phone_id // empty')
    if [ -n "$PHONE_ID" ]; then
        pass "Phone registered, phone_id=$PHONE_ID"
    else
        fail "phone_register_id" "200 but no phone_id in response: $BODY"
    fi
else
    fail "phone_register" "Expected 200, got $STATUS body=$BODY"
fi

# --- POST /api/v1/hosts/phones/{id}/sims ---
echo ""
echo "--- POST /api/v1/hosts/phones/{id}/sims ---"
if [ -n "$PHONE_ID" ]; then
    RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/phones/$PHONE_ID/sims" \
        '{"sims":[{"iccid":"89012345678901234567","phone_number":"+15550001","carrier":"T-Mobile","slot":0,"is_esim":false,"is_active":true}]}' \
        "$NODE_TOKEN")
    STATUS=$(get_status "$RESULT")
    if [ "$STATUS" = "200" ]; then
        pass "SIM report accepted"
    else
        fail "sim_report" "Expected 200, got $STATUS"
    fi
else
    observe "Skipping SIM report (no phone_id)"
fi

# --- POST /api/v1/hosts/dongles/register ---
echo ""
echo "--- POST /api/v1/hosts/dongles/register ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/dongles/register" \
    "{\"host_id\": \"$HOST_ID\", \"dongles\": [{\"bt_mac\": \"AA:BB:CC:DD:EE:FF\"}]}" \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Dongle registration accepted"
else
    fail "dongle_register" "Expected 200, got $STATUS"
fi

# --- POST /api/v1/hosts/events ---
echo ""
echo "--- POST /api/v1/hosts/events ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/events" \
    '{"severity":"info","category":"test","message":"evaluator test event"}' \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Event report accepted"
else
    fail "event_report" "Expected 200, got $STATUS"
fi

# --- POST /api/v1/hosts/phones/deregister ---
echo ""
echo "--- POST /api/v1/hosts/phones/deregister ---"
if [ -n "$PHONE_ID" ]; then
    RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/phones/deregister" \
        "{\"host_id\": \"$HOST_ID\", \"phone_id\": \"$PHONE_ID\"}" \
        "$NODE_TOKEN")
    STATUS=$(get_status "$RESULT")
    if [ "$STATUS" = "200" ]; then
        pass "Phone deregistered"
    else
        fail "phone_deregister" "Expected 200, got $STATUS"
    fi
fi

# --- DELETE /api/v1/hosts/phones/{id} ---
echo ""
echo "--- DELETE /api/v1/hosts/phones/{id} ---"
if [ -n "$PHONE_ID" ]; then
    RESULT=$(http_delete "$REGISTRY_URL/api/v1/hosts/phones/$PHONE_ID" "$NODE_TOKEN")
    STATUS=$(get_status "$RESULT")
    if [ "$STATUS" = "200" ]; then
        pass "Phone permanently deleted"
    else
        fail "phone_delete" "Expected 200, got $STATUS"
    fi
fi

# --- All node paths require auth ---
echo ""
echo "--- Node paths reject unauthenticated requests ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "401" ]; then
    pass "Heartbeat without auth -> 401"
else
    fail "heartbeat_no_auth" "Expected 401, got $STATUS"
fi

# Cleanup
TOKEN_ID=$(find_token_id "$NODE_TOKEN")
if [ -n "$TOKEN_ID" ] && [ "$TOKEN_ID" != "null" ]; then
    revoke_token "$TOKEN_ID"
fi

finish_test "test_new_node_scope_paths"
