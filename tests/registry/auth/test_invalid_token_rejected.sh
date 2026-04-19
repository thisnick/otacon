#!/usr/bin/env bash
# Test 5: Bogus bearer tokens -> 401

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps

echo "=== Test: invalid tokens rejected ==="

BOGUS_TOKENS=(
    "otc_node_garbage123"
    "otc_admin_garbage456"
    "not-even-a-token"
    "Bearer-inception"
    "otc_node_"
    "otc_admin_"
    "null"
    "undefined"
)

for token in "${BOGUS_TOKENS[@]}"; do
    echo ""
    echo "--- Token: '$token' ---"
    RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/heartbeat" \
        '{"host_id": "bogus-test", "phones": [], "dongles": []}' \
        "$token")
    STATUS=$(get_status "$RESULT")
    if [ "$STATUS" = "401" ]; then
        pass "Rejected: '$token' (401)"
    else
        fail "bogus_token" "Token '$token' got $STATUS, expected 401"
    fi
done

# Also test empty Authorization header (just "Bearer " with nothing after)
echo ""
echo "--- Empty bearer value ---"
TMPFILE=$(mktemp)
STATUS=$(curl -s -o "$TMPFILE" -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' \
    -H "Authorization: Bearer " \
    -d '{"host_id": "bogus-test", "phones": [], "dongles": []}' \
    "$REGISTRY_URL/api/v1/hosts/heartbeat" 2>/dev/null) || STATUS="000"
rm -f "$TMPFILE"
if [ "$STATUS" = "401" ]; then
    pass "Rejected: empty bearer (401)"
else
    fail "empty_bearer" "Empty bearer got $STATUS, expected 401"
fi

finish_test "test_invalid_token_rejected"
