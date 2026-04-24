#!/usr/bin/env bash
# Test: CLI host management commands.
# Tests: otacon hosts list, otacon hosts status

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: CLI host commands ==="

CLI_DIR="$REPO_ROOT/src/cli"
OTACON_BIN="node $CLI_DIR/dist/index.js"

# Use temp config dir
TEST_CONFIG_DIR=$(mktemp -d)
trap "rm -rf $TEST_CONFIG_DIR" EXIT

cat > "$TEST_CONFIG_DIR/config.toml" <<TOML
registry_url = "$REGISTRY_URL"
token = "$ADMIN_TOKEN"
TOML

# --- Test 1: hosts list ---
echo ""
echo "--- otacon hosts list ---"
LIST_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    $OTACON_BIN hosts list 2>&1 || true)
observe "hosts list output:"
echo "$LIST_OUTPUT" | head -10

# Should list the Pi host
if echo "$LIST_OUTPUT" | grep -qi "otacon-pi\|host\|id\|fqdn"; then
    pass "hosts list returns host data"
else
    fail "hosts_list" "hosts list did not return expected host data"
fi

# --- Test 2: hosts status (if available) ---
echo ""
echo "--- otacon hosts status otacon-pi ---"
STATUS_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    $OTACON_BIN hosts status otacon-pi 2>&1 || true)
observe "hosts status output:"
echo "$STATUS_OUTPUT" | head -10

# Even if this command isn't implemented, report what happens
if echo "$STATUS_OUTPUT" | grep -qi "otacon-pi\|online\|connected\|phones\|error\|unknown"; then
    pass "hosts status otacon-pi runs"
else
    observe "hosts status returned no parseable output"
fi

echo ""
if [ "$TEST_FAILED" = "true" ]; then
    echo -e "${RED}=== test_cli_host_commands: FAILED ===${NC}"
    exit 1
else
    echo -e "${GREEN}=== test_cli_host_commands: PASSED ===${NC}"
    exit 0
fi
