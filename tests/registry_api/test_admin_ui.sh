#!/usr/bin/env bash
# Test: Admin UI loads on registry port (single binary merger).

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps

echo "=== Test: admin UI on registry port ==="

# Step 1: Root path serves HTML
echo ""
echo "--- GET / returns HTML ---"
RESULT=$(http_get "$REGISTRY_URL/")
STATUS=$(get_status "$RESULT")
BODY=$(get_body "$RESULT")

if [ "$STATUS" = "200" ]; then
    pass "Root path returns 200"
else
    fail "root_status" "Expected 200, got $STATUS"
    finish_test "test_admin_ui"
fi

# Check it's HTML
if echo "$BODY" | grep -qi '<html\|<!doctype'; then
    pass "Response contains HTML"
else
    fail "root_html" "Response does not appear to be HTML"
fi

# Step 2: Verify it's the admin UI (not a generic page)
if echo "$BODY" | grep -qi 'otacon\|registry\|admin\|fleet'; then
    pass "HTML references otacon/registry/admin content"
else
    observe "HTML does not contain expected keywords -- may be a generic page"
fi

finish_test "test_admin_ui"
