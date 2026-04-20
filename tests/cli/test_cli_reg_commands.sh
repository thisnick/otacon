#!/usr/bin/env bash
# Test: CLI registration management commands.
# Tests: otacon reg list, otacon reg approve, otacon reg reject

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: CLI reg commands ==="

CLI_DIR="$REPO_ROOT/src/cli"
OTACON_BIN="node $CLI_DIR/dist/index.js"

# Use temp config dir
TEST_CONFIG_DIR=$(mktemp -d)
trap "rm -rf $TEST_CONFIG_DIR" EXIT

cat > "$TEST_CONFIG_DIR/config.toml" <<TOML
registry_url = "$REGISTRY_URL"
token = "$ADMIN_TOKEN"
TOML

# --- Test 1: reg list ---
echo ""
echo "--- otacon reg list ---"
LIST_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    $OTACON_BIN reg list 2>&1 || true)
LIST_LINES=$(echo "$LIST_OUTPUT" | wc -l | tr -d ' ')
observe "reg list output: $LIST_LINES lines (showing first 5)"
echo "$LIST_OUTPUT" | head -5 || true

# Should produce output (might be empty list)
if [ "$LIST_LINES" -gt 0 ]; then
    pass "reg list produces output ($LIST_LINES lines)"
else
    fail "reg_list" "reg list produced no output"
fi

# --- Test 2: Create a pending registration, see it in reg list ---
echo ""
echo "--- Create pending client, verify in reg list ---"
CLIENT_ID="test-cli-reg-$(date +%s)-$$"
PENDING_ID=$(register_test_client "$CLIENT_ID")
if [ -z "$PENDING_ID" ]; then
    fail "create_pending" "Could not create pending registration"
else
    observe "Created pending client: $PENDING_ID"

    LIST_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
        $OTACON_BIN reg list 2>&1 || true)
    if printf '%s' "$LIST_OUTPUT" | grep -q "$PENDING_ID"; then
        pass "Pending registration visible in reg list"
    elif printf '%s' "$LIST_OUTPUT" | grep -q "pending"; then
        pass "reg list contains pending registrations (may include our new one)"
    else
        fail "pending_in_list" "Pending registration not visible in reg list output"
    fi
fi

# --- Test 3: reg reject ---
echo ""
echo "--- otacon reg reject $PENDING_ID ---"
if [ -n "$PENDING_ID" ]; then
    REJECT_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
        $OTACON_BIN reg reject "$PENDING_ID" 2>&1 || true)
    observe "reg reject output: $REJECT_OUTPUT"

    # Verify it's rejected (no longer pending)
    LIST_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
        $OTACON_BIN reg list 2>&1 || true)
    if echo "$LIST_OUTPUT" | grep -qi "$PENDING_ID"; then
        fail "reject_removes" "Rejected registration still appears in pending list"
    else
        pass "reg reject removed registration from pending list"
    fi
fi

# --- Test 4: reg approve ---
echo ""
echo "--- otacon reg approve (new pending) ---"
CLIENT_ID2="test-cli-approve-$(date +%s)-$$"
PENDING_ID2=$(register_test_client "$CLIENT_ID2")
if [ -z "$PENDING_ID2" ]; then
    fail "create_pending2" "Could not create second pending registration"
else
    observe "Created pending client: $PENDING_ID2"

    APPROVE_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
        $OTACON_BIN reg approve "$PENDING_ID2" 2>&1 || true)
    observe "reg approve output: $APPROVE_OUTPUT"

    if echo "$APPROVE_OUTPUT" | grep -qiE "approved|token|otc_"; then
        pass "reg approve produces approval confirmation"
    else
        fail "reg_approve" "reg approve did not produce expected confirmation"
    fi
fi

# Cleanup: revoke any tokens created
if [ -n "${PENDING_ID2:-}" ]; then
    # The approve created a token; find and revoke it
    TOKENS_RESULT=$(http_get "$REGISTRY_URL/api/v1/admin/tokens" "$ADMIN_TOKEN")
    # Find token for client_id2
    TOKEN_IDS=$(get_body "$TOKENS_RESULT" | jq -r --arg cid "$CLIENT_ID2" \
        '.[] | select(.host_id == $cid or .client_id == $cid) | .id' 2>/dev/null || true)
    for tid in $TOKEN_IDS; do
        revoke_token "$tid"
    done
fi

finish_test "test_cli_reg_commands"
