#!/usr/bin/env bash
# Test: All new admin-scope paths respond correctly under /api/v1/admin/...
# Requires a valid admin token.

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: new admin-scope paths ==="

# First, seed some data via node-scope so admin has something to read
HOST_ID=$(test_host_id)
echo "Seeding data: obtaining node token for host_id=$HOST_ID..."
get_node_token "$HOST_ID"
if [ $? -ne 0 ] || [ -z "$NODE_TOKEN" ]; then
    fail "setup_node_token" "Could not obtain node token"
    finish_test "test_new_admin_scope_paths"
fi

# Heartbeat to create host entry in store
http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
    "{\"host_id\": \"$HOST_ID\", \"phones\": [], \"dongles\": []}" \
    "$NODE_TOKEN" >/dev/null

# Register a phone
http_post "$REGISTRY_URL/api/v1/hosts/phones/register" \
    "{\"host_id\": \"$HOST_ID\", \"adb_serial\": \"ADMIN_TEST_$(date +%s)\", \"model\": \"SM-Test\", \"phone_number\": \"+15559999\"}" \
    "$NODE_TOKEN" >/dev/null

# Register dongles
http_post "$REGISTRY_URL/api/v1/hosts/dongles/register" \
    "{\"host_id\": \"$HOST_ID\", \"dongles\": [{\"bt_mac\": \"11:22:33:44:55:66\"}]}" \
    "$NODE_TOKEN" >/dev/null

# Report SIMs
# Need to find the phone_id first
PHONES_RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/phones" "$ADMIN_TOKEN")
PHONE_ID=$(get_body "$PHONES_RESULT" | jq -r '[.[] | select(.adb_serial | startswith("ADMIN_TEST_"))] | sort_by(.created_at) | last | .id // empty')
if [ -n "$PHONE_ID" ]; then
    http_post "$REGISTRY_URL/api/v1/hosts/phones/$PHONE_ID/sims" \
        '{"sims":[{"iccid":"89999888777666555444","phone_number":"+15559999","carrier":"Test","slot":0,"is_esim":false,"is_active":true}]}' \
        "$NODE_TOKEN" >/dev/null
fi

# Report an event
http_post "$REGISTRY_URL/api/v1/hosts/events" \
    '{"severity":"info","category":"test","message":"admin scope test"}' \
    "$NODE_TOKEN" >/dev/null

echo "Data seeded."

# --- Registration management ---

echo ""
echo "--- GET /api/v1/admin/hosts/pending ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/hosts/pending" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "GET /api/v1/admin/hosts/pending -> 200"
else
    fail "admin_hosts_pending" "Expected 200, got $STATUS"
fi

echo ""
echo "--- GET /api/v1/admin/clients/pending ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/clients/pending" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "GET /api/v1/admin/clients/pending -> 200"
else
    fail "admin_clients_pending" "Expected 200, got $STATUS"
fi

# --- Token management ---

echo ""
echo "--- GET /api/v1/admin/tokens ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/tokens" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "GET /api/v1/admin/tokens -> 200"
    TOKEN_COUNT=$(get_body "$RESULT" | jq 'length')
    observe "Found $TOKEN_COUNT tokens"
else
    fail "admin_tokens" "Expected 200, got $STATUS"
fi

# --- Fleet view ---

echo ""
echo "--- GET /api/v1/admin/hosts ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/hosts" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "GET /api/v1/admin/hosts -> 200"
else
    fail "admin_hosts" "Expected 200, got $STATUS"
fi

echo ""
echo "--- GET /api/v1/admin/phones ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/phones" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "GET /api/v1/admin/phones -> 200"
else
    fail "admin_phones" "Expected 200, got $STATUS"
fi

echo ""
echo "--- GET /api/v1/admin/phones/{id} (enriched detail) ---"
if [ -n "$PHONE_ID" ]; then
    RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/phones/$PHONE_ID" "$ADMIN_TOKEN")
    STATUS=$(get_status "$RESULT")
    BODY=$(get_body "$RESULT")
    if [ "$STATUS" = "200" ]; then
        pass "GET /api/v1/admin/phones/{id} -> 200"

        # Verify enriched response shape per plan
        HAS_HOST=$(echo "$BODY" | jq 'has("host")')
        HAS_SIMS=$(echo "$BODY" | jq 'has("sims")')
        HAS_CONFIG=$(echo "$BODY" | jq 'has("config")')

        if [ "$HAS_HOST" = "true" ]; then
            pass "Phone detail includes 'host' object"
            # Verify host sub-fields
            HOST_HAS_ID=$(echo "$BODY" | jq '.host | has("id")')
            if [ "$HOST_HAS_ID" = "true" ]; then
                pass "host object has 'id' field"
            else
                fail "host_id_field" "host object missing 'id' field"
            fi
        else
            fail "enriched_host" "Phone detail response missing 'host' field"
        fi

        if [ "$HAS_SIMS" = "true" ]; then
            pass "Phone detail includes 'sims' array"
        else
            fail "enriched_sims" "Phone detail response missing 'sims' field"
        fi

        if [ "$HAS_CONFIG" = "true" ]; then
            pass "Phone detail includes 'config' object"
        else
            fail "enriched_config" "Phone detail response missing 'config' field"
        fi
    else
        fail "admin_phone_detail" "Expected 200, got $STATUS"
    fi
else
    observe "Skipping phone detail (no phone_id from seed)"
fi

echo ""
echo "--- PUT /api/v1/admin/phones/{id}/config ---"
if [ -n "$PHONE_ID" ]; then
    RESULT=$(http_put "$REGISTRY_URL/api/v1/admin/phones/$PHONE_ID/config" \
        '{"wifi_enabled":false,"bluetooth_enabled":true}' "$ADMIN_TOKEN")
    STATUS=$(get_status "$RESULT")
    if [ "$STATUS" = "200" ]; then
        pass "PUT /api/v1/admin/phones/{id}/config -> 200"
    else
        fail "admin_phone_config" "Expected 200, got $STATUS"
    fi
fi

echo ""
echo "--- GET /api/v1/admin/sims ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/sims" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "GET /api/v1/admin/sims -> 200"
else
    fail "admin_sims" "Expected 200, got $STATUS"
fi

echo ""
echo "--- GET /api/v1/admin/sims?phone_number=+15559999 ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/sims?phone_number=%2B15559999" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "GET /api/v1/admin/sims?phone_number -> 200 (reverse lookup)"
else
    fail "admin_sims_lookup" "Expected 200, got $STATUS"
fi

echo ""
echo "--- GET /api/v1/admin/dongles ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/dongles" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "GET /api/v1/admin/dongles -> 200"
else
    fail "admin_dongles" "Expected 200, got $STATUS"
fi

echo ""
echo "--- GET /api/v1/admin/events ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/events" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "GET /api/v1/admin/events -> 200"
else
    fail "admin_events" "Expected 200, got $STATUS"
fi

# --- Admin paths require admin auth ---

echo ""
echo "--- Admin paths reject unauthenticated requests ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/phones")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "401" ]; then
    pass "Admin phones without auth -> 401"
else
    fail "admin_no_auth" "Expected 401, got $STATUS"
fi

echo ""
echo "--- Admin paths reject node tokens ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/phones" "$NODE_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "403" ]; then
    pass "Admin phones with node token -> 403"
elif [ "$STATUS" = "401" ]; then
    pass "Admin phones with node token -> 401"
else
    fail "admin_node_token" "Expected 403/401, got $STATUS"
fi

# Cleanup: delete test phone, revoke node token
if [ -n "$PHONE_ID" ]; then
    http_delete "$REGISTRY_URL/api/v1/hosts/phones/$PHONE_ID" "$NODE_TOKEN" >/dev/null 2>&1
fi
TOKEN_ID=$(find_token_id "$NODE_TOKEN")
if [ -n "$TOKEN_ID" ] && [ "$TOKEN_ID" != "null" ]; then
    revoke_token "$TOKEN_ID"
fi

finish_test "test_new_admin_scope_paths"
