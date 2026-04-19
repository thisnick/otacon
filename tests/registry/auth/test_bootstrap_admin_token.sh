#!/usr/bin/env bash
# Test 7: Bootstrap admin token
# - Fresh registry (delete data) prints admin token on stderr
# - Token works for admin endpoints
# - Subsequent restarts do NOT print a new token

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps

echo "=== Test: bootstrap admin token ==="
echo ""
echo "NOTE: This test requires SSH access to the Pi and ability to restart the container."
echo "      It will delete the auth data volume to simulate first-run."
echo ""

PI_HOST="nick@otacon-pi"
# Find the admin container (the one running in admin mode)
CONTAINER=$(ssh "$PI_HOST" "docker ps --format '{{.Names}}' | grep -i admin | head -1" 2>/dev/null || echo "")
if [ -z "$CONTAINER" ]; then
    # Fallback: try common compose naming patterns
    CONTAINER=$(ssh "$PI_HOST" "docker ps --format '{{.Names}}' | grep 'otacon-admin' | head -1" 2>/dev/null || echo "")
fi
if [ -z "$CONTAINER" ]; then
    fail "find_container" "Cannot find admin container on Pi"
    finish_test "test_bootstrap_admin_token"
fi
echo "Using admin container: $CONTAINER"

# Step 1: Clear auth state to simulate first-run
echo "--- Step 1: Reset auth state ---"
# Remove tokens.json so bootstrap fires on next restart
ssh "$PI_HOST" "docker exec $CONTAINER rm -f /data/registry/tokens.json 2>/dev/null || true"
pass "Cleared auth data directory"

# Step 2: Restart the container and capture stderr for bootstrap token
echo ""
echo "--- Step 2: Restart and capture bootstrap token ---"
ssh "$PI_HOST" "docker restart $CONTAINER" >/dev/null 2>&1

# Wait for startup
sleep 5

# Grab only post-restart logs (last 20 lines) looking for the bootstrap token
LOGS=$(ssh "$PI_HOST" "docker logs --since 8s $CONTAINER 2>&1" 2>/dev/null || echo "")
BOOTSTRAP_TOKEN=$(echo "$LOGS" | grep -oP 'otc_admin_[a-f0-9]+' | tail -1)

if [ -n "$BOOTSTRAP_TOKEN" ]; then
    pass "Bootstrap admin token found in logs (prefix=${BOOTSTRAP_TOKEN:0:20}...)"
else
    fail "bootstrap_token" "No bootstrap admin token found in container logs"
    echo "  Last 20 lines of log:"
    echo "$LOGS" | tail -20 | sed 's/^/    /'
    finish_test "test_bootstrap_admin_token"
fi

# Step 3: Verify bootstrap token works for admin endpoints
echo ""
echo "--- Step 3: Verify bootstrap token works ---"
# Wait a bit more for service to be fully ready
sleep 3

RESULT=$(http_get "$ADMIN_URL/api/v1/auth/tokens" "$BOOTSTRAP_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Bootstrap token works for admin endpoints"
else
    fail "bootstrap_works" "Expected 200, got $STATUS"
fi

# Step 4: Restart again, verify NO new token printed
echo ""
echo "--- Step 4: Restart again, verify no new token ---"
ssh "$PI_HOST" "docker restart $CONTAINER" >/dev/null 2>&1
sleep 5

LOGS2=$(ssh "$PI_HOST" "docker logs --since 10s $CONTAINER 2>&1" 2>/dev/null || echo "")
NEW_TOKEN=$(echo "$LOGS2" | grep -oP 'otc_admin_[a-f0-9]+' 2>/dev/null | head -1 || true)

if [ -z "$NEW_TOKEN" ]; then
    pass "No new bootstrap token on subsequent restart"
else
    # Check if it's the same token (which would also be a problem -- shouldn't print it again)
    if [ "$NEW_TOKEN" = "$BOOTSTRAP_TOKEN" ]; then
        fail "token_reprinted" "Same bootstrap token printed again on restart (security: should only print once)"
    else
        fail "new_token_on_restart" "New bootstrap token generated on restart: ${NEW_TOKEN:0:20}..."
    fi
fi

# Step 5: Verify original bootstrap token still works after restart
echo ""
echo "--- Step 5: Original token still valid after restart ---"
sleep 3
RESULT=$(http_get "$ADMIN_URL/api/v1/auth/tokens" "$BOOTSTRAP_TOKEN")
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Original bootstrap token still valid after restart"
else
    fail "token_persists" "Expected 200, got $STATUS"
fi

# Export for other tests to use
echo ""
echo "Bootstrap admin token for other tests:"
echo "  export OTACON_ADMIN_TOKEN=$BOOTSTRAP_TOKEN"

finish_test "test_bootstrap_admin_token"
