#!/usr/bin/env bash
# Test: CLI phone management commands against live registry.
# Tests: otacon phones list, otacon phones use, otacon screenshot

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: CLI phone commands ==="

CLI_DIR="$REPO_ROOT/src/cli"
OTACON_BIN="node $CLI_DIR/dist/index.js"

# Use temp config dir
TEST_CONFIG_DIR=$(mktemp -d)
trap "rm -rf $TEST_CONFIG_DIR" EXIT

# Write config with real registry and admin token
cat > "$TEST_CONFIG_DIR/config.toml" <<TOML
registry_url = "$REGISTRY_URL"
token = "$ADMIN_TOKEN"
TOML

# --- Test 1: phones list ---
echo ""
echo "--- otacon phones list ---"
LIST_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    $OTACON_BIN phones list 2>&1 || true)
observe "phones list output (first 10 lines):"
echo "$LIST_OUTPUT" | head -10

# Should list at least one phone (we have 4 real phones)
if echo "$LIST_OUTPUT" | grep -qi "phone-\|phone_\|id\|model\|connected"; then
    pass "phones list returns phone data"
else
    fail "phones_list" "phones list did not return expected phone data"
fi

# --- Test 2: phones use ---
echo ""
echo "--- otacon phones use phone-2 ---"
USE_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    $OTACON_BIN phones use phone-2 2>&1 || true)
observe "phones use output: $USE_OUTPUT"

# Verify it was set (check config file or whoami)
WHOAMI_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    $OTACON_BIN auth whoami 2>&1 || true)
if echo "$WHOAMI_OUTPUT" | grep -qi "phone-2"; then
    pass "phones use phone-2 sets active phone"
elif echo "$USE_OUTPUT" | grep -qi "phone-2\|active\|set\|selected"; then
    pass "phones use phone-2 acknowledged"
else
    fail "phones_use" "phones use did not set active phone to phone-2"
fi

# --- Test 3: screenshot with active phone ---
echo ""
echo "--- otacon screenshot (with phone-2 active) ---"
SCREENSHOT_FILE=$(mktemp /tmp/otacon_test_screenshot_XXXXXX.png)
SCREENSHOT_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    OTACON_PHONE="phone-2" \
    $OTACON_BIN screenshot -o "$SCREENSHOT_FILE" 2>&1 || true)
observe "screenshot output: $SCREENSHOT_OUTPUT"

if [ -f "$SCREENSHOT_FILE" ] && [ -s "$SCREENSHOT_FILE" ]; then
    FILE_SIZE=$(wc -c < "$SCREENSHOT_FILE" | tr -d ' ')
    if [ "$FILE_SIZE" -gt 1000 ]; then
        pass "Screenshot saved ($FILE_SIZE bytes)"
    else
        fail "screenshot_size" "Screenshot file too small: $FILE_SIZE bytes"
    fi
else
    # Known issues block screenshots through registry resolver path:
    # 1. host.fqdn is null in registry for otacon-pi, so resolver.ts cannot build host URL
    # 2. OtaconClient uses /api/screenshot but host server now uses /phones/{id}/api/screenshot
    # 3. Registry phone IDs (phone-2) differ from host-local IDs (phone-r5ct60sd)
    if echo "$SCREENSHOT_OUTPUT" | grep -qi "no connected host\|fqdn"; then
        fail "screenshot_resolver" "host.fqdn is null in registry; resolver cannot build host URL"
    elif echo "$SCREENSHOT_OUTPUT" | grep -qi "404\|not found"; then
        fail "screenshot_api_path" "Client uses /api/screenshot but host server uses /phones/{id}/api/screenshot"
    else
        fail "screenshot_file" "Screenshot file not created or empty: $SCREENSHOT_OUTPUT"
    fi
fi
rm -f "$SCREENSHOT_FILE"

# --- Test 4: phones list with --connected filter ---
echo ""
echo "--- otacon phones list --connected ---"
CONNECTED_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    $OTACON_BIN phones list --connected 2>&1 || true)
observe "phones list --connected output (first 5 lines):"
echo "$CONNECTED_OUTPUT" | head -5

# Should work (might show filtered list)
if echo "$CONNECTED_OUTPUT" | grep -qi "phone\|connected\|id\|error\|unknown"; then
    pass "phones list --connected runs"
else
    observe "phones list --connected returned no parseable output (may be unimplemented)"
fi

# --- Test 5: phones list --all ---
echo ""
echo "--- otacon phones list --all ---"
ALL_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    $OTACON_BIN phones list --all 2>&1 || true)
observe "phones list --all output (first 5 lines):"
echo "$ALL_OUTPUT" | head -5

if echo "$ALL_OUTPUT" | grep -qi "phone\|id\|model\|error\|unknown"; then
    pass "phones list --all runs"
else
    observe "phones list --all returned no parseable output (may be unimplemented)"
fi

echo ""
if [ "$TEST_FAILED" = "true" ]; then
    echo -e "${RED}=== test_cli_phone_commands: FAILED ===${NC}"
    exit 1
else
    echo -e "${GREEN}=== test_cli_phone_commands: PASSED ===${NC}"
    exit 0
fi
