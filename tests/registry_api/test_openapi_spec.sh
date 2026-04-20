#!/usr/bin/env bash
# Test: OpenAPI spec is served and covers all endpoints.

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps

echo "=== Test: OpenAPI spec ==="

# Step 1: Spec is served at expected path
echo ""
echo "--- GET /api/docs/openapi.json ---"
RESULT=$(http_get "$REGISTRY_URL/api/docs/openapi.json")
STATUS=$(get_status "$RESULT")
BODY=$(get_body "$RESULT")

if [ "$STATUS" = "200" ]; then
    pass "OpenAPI spec served at /api/docs/openapi.json"
else
    fail "spec_served" "Expected 200, got $STATUS"
    finish_test "test_openapi_spec"
fi

# Step 2: Valid JSON
echo ""
echo "--- Spec is valid JSON ---"
if echo "$BODY" | jq . >/dev/null 2>&1; then
    pass "Spec is valid JSON"
else
    fail "valid_json" "Spec is not valid JSON"
    finish_test "test_openapi_spec"
fi

# Step 3: Has required OpenAPI fields
echo ""
echo "--- Spec has required OpenAPI structure ---"
OPENAPI_VERSION=$(echo "$BODY" | jq -r '.openapi // empty')
if [ -n "$OPENAPI_VERSION" ]; then
    pass "Has openapi version field: $OPENAPI_VERSION"
else
    fail "openapi_version" "Missing 'openapi' version field"
fi

INFO=$(echo "$BODY" | jq -r '.info.title // empty')
if [ -n "$INFO" ]; then
    pass "Has info.title: $INFO"
else
    fail "info_title" "Missing 'info.title' field"
fi

PATHS=$(echo "$BODY" | jq -r '.paths // empty')
if [ "$PATHS" != "" ] && [ "$PATHS" != "null" ]; then
    PATH_COUNT=$(echo "$BODY" | jq '.paths | keys | length')
    pass "Has paths object ($PATH_COUNT paths)"
else
    fail "paths" "Missing 'paths' object"
    finish_test "test_openapi_spec"
fi

# Step 4: Check all expected endpoints are in the spec
echo ""
echo "--- Checking expected endpoints in spec ---"

EXPECTED_PATHS=(
    "/api/v1/hosts/register"
    "/api/v1/hosts/poll/{id}"
    "/api/v1/clients/register"
    "/api/v1/clients/poll/{id}"
    "/api/v1/hosts/heartbeat"
    "/api/v1/hosts/phones/register"
    "/api/v1/hosts/phones/deregister"
    "/api/v1/hosts/dongles/register"
    "/api/v1/hosts/events"
    "/api/v1/admin/hosts/pending"
    "/api/v1/admin/clients/pending"
    "/api/v1/admin/tokens"
    "/api/v1/admin/hosts"
    "/api/v1/admin/phones"
    "/api/v1/admin/sims"
    "/api/v1/admin/dongles"
    "/api/v1/admin/events"
)

# OpenAPI path params may use different syntax, so also try {pending_id}
SPEC_PATHS=$(echo "$BODY" | jq -r '.paths | keys[]')

for expected in "${EXPECTED_PATHS[@]}"; do
    # Check exact match or with common path param variants
    FOUND=false
    for spec_path in $SPEC_PATHS; do
        # Normalize: replace {pending_id} with {id}, etc.
        NORMALIZED=$(echo "$spec_path" | sed 's/{[^}]*}/{id}/g')
        EXPECTED_NORMALIZED=$(echo "$expected" | sed 's/{[^}]*}/{id}/g')
        if [ "$NORMALIZED" = "$EXPECTED_NORMALIZED" ]; then
            FOUND=true
            break
        fi
    done
    if [ "$FOUND" = "true" ]; then
        pass "Spec includes $expected"
    else
        fail "missing_path_$expected" "Spec missing $expected"
    fi
done

# Step 5: Check some paths that should NOT be in spec (old paths)
echo ""
echo "--- Old paths should not appear in spec ---"
OLD_PATHS=(
    "/api/v1/auth/register"
    "/api/v1/auth/poll/{id}"
    "/api/v1/auth/registrations/pending"
    "/api/v1/auth/tokens"
    "/api/v1/phones/register"
    "/api/v1/phones/deregister"
    "/api/v1/dongles/register"
)

for old in "${OLD_PATHS[@]}"; do
    FOUND=false
    for spec_path in $SPEC_PATHS; do
        NORMALIZED=$(echo "$spec_path" | sed 's/{[^}]*}/{id}/g')
        OLD_NORMALIZED=$(echo "$old" | sed 's/{[^}]*}/{id}/g')
        if [ "$NORMALIZED" = "$OLD_NORMALIZED" ]; then
            FOUND=true
            break
        fi
    done
    if [ "$FOUND" = "false" ]; then
        pass "Old path $old not in spec"
    else
        fail "old_path_in_spec" "Old path $old still in spec"
    fi
done

finish_test "test_openapi_spec"
