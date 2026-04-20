#!/usr/bin/env bash
# Test: All OLD API paths are inaccessible after migration.
# Verifies the path migration table from the plan.
# Accepts 404 (no route) or 401 (auth middleware rejects before routing) as valid.

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: old paths inaccessible ==="

# Helper: check that a path returns 404 or 401 (both mean "not accessible")
assert_gone() {
    local label="$1" status="$2"
    if [ "$status" = "404" ] || [ "$status" = "401" ]; then
        pass "$label -> $status (inaccessible)"
    else
        fail "$label" "Expected 404 or 401, got $status"
    fi
}

# --- Old public paths ---

echo ""
echo "--- Old auth/register path ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/auth/register" '{"host_id":"test"}')
STATUS=$(get_status "$RESULT")
assert_gone "POST /api/v1/auth/register" "$STATUS"

echo ""
echo "--- Old auth/poll path ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/auth/poll/fake-id" '{}')
STATUS=$(get_status "$RESULT")
assert_gone "POST /api/v1/auth/poll/{id}" "$STATUS"

# --- Old admin auth paths ---

echo ""
echo "--- Old auth/registrations/pending ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/auth/registrations/pending" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
assert_gone "GET /api/v1/auth/registrations/pending" "$STATUS"

echo ""
echo "--- Old auth/registrations/{id}/approve ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/auth/registrations/fake/approve" '{}' "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
assert_gone "POST /api/v1/auth/registrations/{id}/approve" "$STATUS"

echo ""
echo "--- Old auth/registrations/{id}/reject ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/auth/registrations/fake/reject" '{}' "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
assert_gone "POST /api/v1/auth/registrations/{id}/reject" "$STATUS"

echo ""
echo "--- Old auth/tokens ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/auth/tokens" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
assert_gone "GET /api/v1/auth/tokens" "$STATUS"

# --- Old node-scope paths (now under /hosts/) ---

echo ""
echo "--- Old hosts/register (node-scope, now heartbeat) ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/hosts/register" '{"id":"test","api_port":8080}' "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
# Note: /api/v1/hosts/register is REUSED as public host registration, so it should NOT 404.
# The old node-authed POST /api/v1/hosts/register with RegisterHostBody shape is replaced.
# We skip this check -- it's now the public registration endpoint with different body shape.
observe "POST /api/v1/hosts/register is now public registration (different body shape)"

echo ""
echo "--- Old phones/register (was at /api/v1/phones/register) ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/phones/register" '{"host_id":"test","adb_serial":"123"}')
STATUS=$(get_status "$RESULT")
assert_gone "POST /api/v1/phones/register" "$STATUS"

echo ""
echo "--- Old phones/deregister ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/phones/deregister" '{"host_id":"test","phone_id":"p1"}')
STATUS=$(get_status "$RESULT")
assert_gone "POST /api/v1/phones/deregister" "$STATUS"

echo ""
echo "--- Old dongles/register ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/dongles/register" '{"host_id":"test","dongles":[]}')
STATUS=$(get_status "$RESULT")
assert_gone "POST /api/v1/dongles/register" "$STATUS"

echo ""
echo "--- Old events (node POST) ---"
RESULT=$(http_post "$REGISTRY_URL/api/v1/events" '{"severity":"info","category":"test","message":"x"}')
STATUS=$(get_status "$RESULT")
assert_gone "POST /api/v1/events" "$STATUS"

# --- Old admin read paths (now under /admin/) ---

echo ""
echo "--- Old phones list (was at /api/v1/phones) ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/phones" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
assert_gone "GET /api/v1/phones" "$STATUS"

echo ""
echo "--- Old hosts list (was at /api/v1/hosts) ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/hosts" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
assert_gone "GET /api/v1/hosts" "$STATUS"

echo ""
echo "--- Old events list (was at /api/v1/events GET) ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/events" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
assert_gone "GET /api/v1/events" "$STATUS"

echo ""
echo "--- Old sims list (was at /api/v1/sims) ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/sims" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
assert_gone "GET /api/v1/sims" "$STATUS"

echo ""
echo "--- Old dongles list (was at /api/v1/dongles) ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/dongles" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
assert_gone "GET /api/v1/dongles" "$STATUS"

# --- Removed endpoints ---

echo ""
echo "--- Removed PATCH /api/v1/phones/{id} ---"
RESULT=$(http_patch "$REGISTRY_URL/api/v1/phones/test-phone" '{"phone_number":"+1"}' "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
assert_gone "PATCH /api/v1/phones/{id}" "$STATUS"

echo ""
echo "--- Removed admin DELETE /api/v1/phones/{id} ---"
RESULT=$(http_delete "$REGISTRY_URL/api/v1/phones/nonexistent" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
assert_gone "DELETE /api/v1/phones/{id}" "$STATUS"

echo ""
echo "--- Removed GET /api/v1/phones/{id}/location ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/phones/test/location" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
assert_gone "GET /api/v1/phones/{id}/location" "$STATUS"

echo ""
echo "--- Removed GET /api/v1/phones/{id}/sims (admin read) ---"
RESULT=$(http_get "$REGISTRY_URL/api/v1/phones/test/sims" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
assert_gone "GET /api/v1/phones/{id}/sims" "$STATUS"

finish_test "test_old_paths_return_404"
