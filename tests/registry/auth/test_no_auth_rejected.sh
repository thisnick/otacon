#!/usr/bin/env bash
# Test 4: Requests with no Authorization header -> 401

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps

echo "=== Test: no-auth requests rejected ==="

# Test 1: POST heartbeat without auth
echo ""
echo "--- POST heartbeat (no auth) ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    '{"host_id": "no-auth-test", "phones": [], "dongles": []}')
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "401" ]; then
    pass "Heartbeat rejected without auth (401)"
else
    fail "heartbeat_no_auth" "Expected 401, got $STATUS"
fi

# Test 2: GET hosts without auth
echo ""
echo "--- GET hosts (no auth) ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/hosts")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "401" ]; then
    pass "List hosts rejected without auth (401)"
else
    fail "list_hosts_no_auth" "Expected 401, got $STATUS"
fi

# Test 3: GET phones without auth
echo ""
echo "--- GET phones (no auth) ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/phones")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "401" ]; then
    pass "List phones rejected without auth (401)"
else
    fail "list_phones_no_auth" "Expected 401, got $STATUS"
fi

# Test 4: POST host register without auth
echo ""
echo "--- POST host register (no auth) ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/register" \
    '{"id": "no-auth-test"}')
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "401" ]; then
    pass "Host register rejected without auth (401)"
else
    fail "host_register_no_auth" "Expected 401, got $STATUS"
fi

# Test 5: POST events without auth
echo ""
echo "--- POST events (no auth) ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/events" \
    '{"host_id": "test", "severity": "info", "category": "test", "message": "test"}')
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "401" ]; then
    pass "Events rejected without auth (401)"
else
    fail "events_no_auth" "Expected 401, got $STATUS"
fi

# Test 6: Admin endpoints without auth
echo ""
echo "--- Admin endpoints (no auth) ---"
RESULT=$(http_get "$ADMIN_URL/api/v1/auth/tokens")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "401" ]; then
    pass "Admin list tokens rejected without auth (401)"
else
    fail "admin_tokens_no_auth" "Expected 401, got $STATUS"
fi

RESULT=$(http_get "$ADMIN_URL/api/v1/auth/registrations/pending")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "401" ]; then
    pass "Admin list registrations rejected without auth (401)"
else
    fail "admin_registrations_no_auth" "Expected 401, got $STATUS"
fi

# Note: auth/register itself should be PUBLIC (no auth required)
echo ""
echo "--- Auth register endpoint (should be public) ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/auth/register" \
    '{"host_id": "public-register-test"}')
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ]; then
    pass "Auth register is public (no auth required) - status=$STATUS"
    # Clean up the pending registration if possible
    PENDING_ID=$(get_body "$RESULT" | jq -r '.pending_id // .id // empty')
    if [ -n "$PENDING_ID" ] && [ -n "$ADMIN_TOKEN" ]; then
        http_post "$ADMIN_URL/api/v1/auth/registrations/$PENDING_ID/reject" \
            '{}' "$ADMIN_TOKEN" >/dev/null 2>&1 || true
    fi
else
    fail "auth_register_public" "Expected 200/201 (public), got $STATUS"
fi

finish_test "test_no_auth_rejected"
