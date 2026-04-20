#!/usr/bin/env bash
# Test: CLI builds successfully (npm run build in src/cli).
# This is a prerequisite for all other CLI tests.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}  [PASS]${NC} $1"; }
fail() { echo -e "${RED}  [FAIL]${NC} $1 -- $2"; TEST_FAILED=true; }
observe() { echo -e "${YELLOW}  [OBSERVE]${NC} $1"; }

TEST_FAILED=false

echo "=== Test: CLI build ==="

CLI_DIR="$REPO_ROOT/src/cli"

# --- Test 1: npm run build succeeds ---
echo ""
echo "--- npm run build ---"
cd "$CLI_DIR"
if npm run build 2>&1; then
    pass "npm run build succeeded"
else
    fail "npm_build" "npm run build failed"
fi

# --- Test 2: dist/index.js exists ---
echo ""
echo "--- Check dist/index.js exists ---"
if [ -f "$CLI_DIR/dist/index.js" ]; then
    pass "dist/index.js exists"
else
    fail "dist_index" "dist/index.js not found"
fi

# --- Test 3: otacon --help works ---
echo ""
echo "--- otacon --help ---"
HELP_OUTPUT=$(node "$CLI_DIR/dist/index.js" --help 2>&1 || true)
if echo "$HELP_OUTPUT" | grep -q "otacon"; then
    pass "otacon --help produces output"
else
    fail "help_output" "otacon --help did not produce expected output"
fi

# --- Test 4: Check for new subcommand groups ---
echo ""
echo "--- Check subcommand groups in help ---"
HAS_AUTH=$(echo "$HELP_OUTPUT" | grep -c "auth" || true)
HAS_PHONE=$(echo "$HELP_OUTPUT" | grep -c "phone" || true)
HAS_REG=$(echo "$HELP_OUTPUT" | grep -c "reg" || true)
HAS_HOST=$(echo "$HELP_OUTPUT" | grep -c "host" || true)

if [ "$HAS_AUTH" -ge 1 ]; then
    pass "'auth' subcommand appears in help"
else
    fail "auth_subcommand" "'auth' subcommand missing from help output"
fi

if [ "$HAS_PHONE" -ge 1 ]; then
    pass "'phone' subcommand appears in help"
else
    fail "phone_subcommand" "'phone' subcommand missing from help output"
fi

if [ "$HAS_REG" -ge 1 ]; then
    pass "'reg' subcommand appears in help"
else
    fail "reg_subcommand" "'reg' subcommand missing from help output"
fi

if [ "$HAS_HOST" -ge 1 ]; then
    pass "'host' subcommand appears in help"
else
    fail "host_subcommand" "'host' subcommand missing from help output"
fi

# --- Test 5: Existing commands still present ---
echo ""
echo "--- Existing commands preserved ---"
for cmd in screenshot snapshot tap swipe sms call; do
    if echo "$HELP_OUTPUT" | grep -q "$cmd"; then
        pass "'$cmd' command preserved"
    else
        fail "${cmd}_preserved" "'$cmd' command missing from help"
    fi
done

# --- Test 6: Check for --phone global flag ---
echo ""
echo "--- Check --phone global flag ---"
if echo "$HELP_OUTPUT" | grep -q "\-\-phone"; then
    pass "--phone global flag present"
else
    fail "phone_flag" "--phone global flag missing from help"
fi

echo ""
if [ "$TEST_FAILED" = "true" ]; then
    echo -e "${RED}=== test_cli_build: FAILED ===${NC}"
    exit 1
else
    echo -e "${GREEN}=== test_cli_build: PASSED ===${NC}"
    exit 0
fi
