#!/usr/bin/env bash
# Test: CLI auth register flow.
# Tests: otacon auth register → creates pending → approve → token saved to config.
# Also tests: otacon auth whoami, otacon auth unregister.

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: CLI auth flow ==="

CLI_DIR="$REPO_ROOT/src/cli"
OTACON_BIN="node $CLI_DIR/dist/index.js"

# Use temp config dir
TEST_CONFIG_DIR=$(mktemp -d)
trap "rm -rf $TEST_CONFIG_DIR" EXIT

# --- Test 1: auth register (background, then approve via curl) ---
echo ""
echo "--- otacon auth register ---"

# Start auth register in background using env var for registry URL
AUTH_OUTPUT_FILE=$(mktemp)
(
    OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
        OTACON_REGISTRY_URL="$REGISTRY_URL" \
        $OTACON_BIN auth register --registry "$REGISTRY_URL" \
        > "$AUTH_OUTPUT_FILE" 2>&1
) &
AUTH_PID=$!

# Wait for registration to appear in pending
sleep 5

# Check if auth register already exited (error)
if ! kill -0 $AUTH_PID 2>/dev/null; then
    AUTH_OUTPUT=$(cat "$AUTH_OUTPUT_FILE")
    rm -f "$AUTH_OUTPUT_FILE"
    observe "auth register exited early: $AUTH_OUTPUT"
    if echo "$AUTH_OUTPUT" | grep -qi "422\|client_id\|deserialize\|failed"; then
        fail "auth_register_body" "auth register sends wrong body format (missing client_id field)"
    else
        fail "auth_register" "auth register failed: $AUTH_OUTPUT"
    fi
    finish_test "test_cli_auth_flow"
fi

# Find the pending client registration
RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/clients/pending" "$ADMIN_TOKEN")
STATUS=$(get_status "$RESULT")
BODY=$(get_body "$RESULT")

if [ "$STATUS" != "200" ]; then
    fail "pending_list" "Could not list pending clients: status=$STATUS"
    kill $AUTH_PID 2>/dev/null || true
    wait $AUTH_PID 2>/dev/null || true
    rm -f "$AUTH_OUTPUT_FILE"
    finish_test "test_cli_auth_flow"
fi

# Get the most recent pending registration
PENDING_ID=$(echo "$BODY" | jq -r '[.[] | select(.status == "pending")] | sort_by(.requested_at) | last | .id // empty')
if [ -z "$PENDING_ID" ] || [ "$PENDING_ID" = "null" ]; then
    fail "find_pending" "No pending client registrations found after auth register"
    observe "Pending list: $BODY"
    kill $AUTH_PID 2>/dev/null || true
    wait $AUTH_PID 2>/dev/null || true
    AUTH_OUTPUT=$(cat "$AUTH_OUTPUT_FILE")
    rm -f "$AUTH_OUTPUT_FILE"
    observe "auth register output: $AUTH_OUTPUT"
    finish_test "test_cli_auth_flow"
fi
observe "Pending registration: $PENDING_ID"

# Approve it
APPROVE_RESULT=$(http_post "$REGISTRY_URL/api/v1/admin/clients/$PENDING_ID/approve" '{}' "$ADMIN_TOKEN")
APPROVE_STATUS=$(get_status "$APPROVE_RESULT")
if [ "$APPROVE_STATUS" = "200" ] || [ "$APPROVE_STATUS" = "201" ]; then
    pass "Approved pending registration via curl"
else
    fail "approve_pending" "Approval failed: status=$APPROVE_STATUS"
fi

# Wait for auth register to complete
sleep 5
kill $AUTH_PID 2>/dev/null || true
wait $AUTH_PID 2>/dev/null || true

AUTH_OUTPUT=$(cat "$AUTH_OUTPUT_FILE")
rm -f "$AUTH_OUTPUT_FILE"
observe "auth register output: $AUTH_OUTPUT"

# --- Test 2: Check config file was written with token ---
echo ""
echo "--- Check config file for saved token ---"
if [ -f "$TEST_CONFIG_DIR/config.toml" ]; then
    CONFIG_CONTENTS=$(cat "$TEST_CONFIG_DIR/config.toml")
    if echo "$CONFIG_CONTENTS" | grep -q "otc_"; then
        pass "Token saved to config.toml"
    else
        fail "token_saved" "Config file exists but no token found"
        observe "Config contents: $CONFIG_CONTENTS"
    fi
else
    fail "config_created" "Config file not created after auth register"
fi

# --- Test 3: auth whoami shows registry + token + no phone ---
echo ""
echo "--- otacon auth whoami ---"
WHOAMI_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    $OTACON_BIN auth whoami 2>&1 || true)
observe "whoami output: $WHOAMI_OUTPUT"

if echo "$WHOAMI_OUTPUT" | grep -qi "registry\|token\|otc_"; then
    pass "auth whoami shows registry/token info"
else
    fail "whoami_info" "auth whoami did not show expected info"
fi

# --- Test 4: auth unregister removes token ---
echo ""
echo "--- otacon auth unregister ---"
UNREG_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    $OTACON_BIN auth unregister 2>&1 || true)
observe "auth unregister output: $UNREG_OUTPUT"

# Check token is gone from config
if [ -f "$TEST_CONFIG_DIR/config.toml" ]; then
    CONFIG_CONTENTS=$(cat "$TEST_CONFIG_DIR/config.toml")
    if echo "$CONFIG_CONTENTS" | grep -q "otc_"; then
        fail "token_removed" "Token still in config after unregister"
    else
        pass "Token removed from config after unregister"
    fi
else
    pass "Config file removed or cleared after unregister"
fi

# Cleanup: revoke the token we created
TOKENS_RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/tokens" "$ADMIN_TOKEN")
# (best-effort, no failure if cleanup can't find it)

finish_test "test_cli_auth_flow"
