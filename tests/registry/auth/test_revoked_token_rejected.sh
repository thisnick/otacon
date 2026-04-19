#!/usr/bin/env bash
# Test 6: Revoked token immediately returns 401

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: revoked token rejected ==="

HOST_ID=$(test_host_id)

# Get a valid token
get_node_token "$HOST_ID"
if [ $? -ne 0 ] || [ -z "$NODE_TOKEN" ]; then
    fail "setup" "Could not obtain node token"
    finish_test "test_revoked_token_rejected"
fi

# Confirm token works
echo ""
echo "--- Verify token works before revoke ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Token works before revoke"
else
    fail "pre_revoke" "Expected 200, got $STATUS"
fi

# Revoke
echo ""
echo "--- Revoking token ---"
if [ -n "$TOKEN_ID" ] && [ "$TOKEN_ID" != "null" ]; then
    REVOKE_RESULT=$(http_post "$ADMIN_URL/api/v1/auth/tokens/$TOKEN_ID/revoke" \
        '{}' "$ADMIN_TOKEN")
    REVOKE_STATUS=$(get_status "$REVOKE_RESULT")
    if [ "$REVOKE_STATUS" = "200" ]; then
        pass "Token revoked"
    else
        fail "revoke" "status=$REVOKE_STATUS"
        finish_test "test_revoked_token_rejected"
    fi
else
    fail "revoke" "No token_id found"
    finish_test "test_revoked_token_rejected"
fi

# Immediately use revoked token
echo ""
echo "--- Using revoked token (should fail immediately) ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "401" ]; then
    pass "Revoked token immediately rejected (401)"
else
    fail "revoked_immediate" "Expected 401, got $STATUS -- token may be cached"
fi

# Try again after a brief pause (catch time-based cache issues)
sleep 2
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
    "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "401" ]; then
    pass "Revoked token still rejected after 2s (401)"
else
    fail "revoked_delayed" "Expected 401, got $STATUS"
fi

finish_test "test_revoked_token_rejected"
