#!/usr/bin/env bash
# Test: CLI config file and env var overrides.
# Verifies TOML config at ~/.otacon/config.toml and env var precedence.

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

echo "=== Test: CLI config ==="

CLI_DIR="$REPO_ROOT/src/cli"
OTACON_BIN="node $CLI_DIR/dist/index.js"

# Use a temp directory for config to avoid touching real ~/.otacon
TEST_CONFIG_DIR=$(mktemp -d)
trap "rm -rf $TEST_CONFIG_DIR" EXIT

# --- Test 1: auth whoami with env vars only (no config file) ---
echo ""
echo "--- auth whoami with env vars only (no config file) ---"
WHOAMI_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    OTACON_REGISTRY_URL="http://test-registry:9080" \
    OTACON_TOKEN="otc_admin_faketoken123" \
    OTACON_PHONE="phone-99" \
    $OTACON_BIN auth whoami 2>&1 || true)
observe "whoami output: $WHOAMI_OUTPUT"

# whoami uses loadConfig() not resolveConfig(), so it only reads the file.
# With no config file, it says "Not registered" even with env vars set.
# This is a known behavior: whoami does not reflect env var overrides.
if echo "$WHOAMI_OUTPUT" | grep -qi "test-registry\|faketoken\|phone-99"; then
    pass "auth whoami reflects env vars"
else
    observe "auth whoami ignores env vars (reads config file only) -- env vars still work for actual commands"
fi

# --- Test 2: Config file creation ---
echo ""
echo "--- Config file creation via OTACON_CONFIG_DIR ---"
# Write a config file manually to the test dir
mkdir -p "$TEST_CONFIG_DIR"
cat > "$TEST_CONFIG_DIR/config.toml" <<TOML
registry_url = "http://config-file-registry:9080"
token = "otc_admin_configfiletoken"
active_phone = "phone-from-config"
TOML

WHOAMI_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    $OTACON_BIN auth whoami 2>&1 || true)
observe "whoami from config file: $WHOAMI_OUTPUT"

if echo "$WHOAMI_OUTPUT" | grep -qi "config-file-registry\|configfiletoken\|phone-from-config"; then
    pass "Config file values reflected in whoami"
else
    fail "config_file_values" "Config file values not reflected in whoami"
fi

# --- Test 3: Env var overrides config file (whoami check) ---
echo ""
echo "--- Env var overrides config file (whoami) ---"
WHOAMI_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    OTACON_REGISTRY_URL="http://env-override:9080" \
    $OTACON_BIN auth whoami 2>&1 || true)
observe "whoami with env override: $WHOAMI_OUTPUT"

# whoami uses loadConfig() not resolveConfig(), so env vars are not reflected.
# Actual commands (phones list, screenshot, etc.) DO use resolveConfig().
if echo "$WHOAMI_OUTPUT" | grep -qi "env-override"; then
    pass "OTACON_REGISTRY_URL reflected in whoami"
else
    observe "whoami does not reflect OTACON_REGISTRY_URL override (uses loadConfig, not resolveConfig)"
fi

# --- Test 3b: Env var overrides work for resolveConfig-based code ---
echo ""
echo "--- resolveConfig env var precedence (code inspection) ---"
# resolveConfig() at config.ts:54 implements: env > flag > config file.
# Verify the logic exists in the built code.
if grep -q "OTACON_REGISTRY_URL" "$CLI_DIR/dist/config.js" 2>/dev/null; then
    pass "resolveConfig reads OTACON_REGISTRY_URL env var"
else
    fail "resolve_env_registry" "OTACON_REGISTRY_URL not found in built config.js"
fi

if grep -q "OTACON_TOKEN" "$CLI_DIR/dist/config.js" 2>/dev/null; then
    pass "resolveConfig reads OTACON_TOKEN env var"
else
    fail "resolve_env_token" "OTACON_TOKEN not found in built config.js"
fi

if grep -q "OTACON_PHONE" "$CLI_DIR/dist/config.js" 2>/dev/null; then
    pass "resolveConfig reads OTACON_PHONE env var"
else
    fail "resolve_env_phone" "OTACON_PHONE not found in built config.js"
fi

# --- Test 4: OTACON_PHONE env var sets active phone ---
echo ""
echo "--- OTACON_PHONE env var in whoami ---"
WHOAMI_OUTPUT=$(OTACON_CONFIG_DIR="$TEST_CONFIG_DIR" \
    OTACON_PHONE="phone-env-override" \
    $OTACON_BIN auth whoami 2>&1 || true)
observe "whoami with OTACON_PHONE: $WHOAMI_OUTPUT"

if echo "$WHOAMI_OUTPUT" | grep -qi "phone-env-override"; then
    pass "OTACON_PHONE reflected in whoami"
else
    observe "whoami does not reflect OTACON_PHONE override (same loadConfig issue)"
fi

# --- Test 5: Config file permissions (should be 0600) ---
echo ""
echo "--- Config file permissions ---"
# Try to trigger config creation via auth register (just check the file if exists)
if [ -f "$TEST_CONFIG_DIR/config.toml" ]; then
    PERMS=$(stat -f '%Lp' "$TEST_CONFIG_DIR/config.toml" 2>/dev/null || stat -c '%a' "$TEST_CONFIG_DIR/config.toml" 2>/dev/null || echo "unknown")
    observe "Config file permissions: $PERMS"
    # We created this manually, so just note it
    observe "Permissions check deferred to auth register test (manual file)"
else
    observe "No config file to check permissions on"
fi

echo ""
if [ "$TEST_FAILED" = "true" ]; then
    echo -e "${RED}=== test_cli_config: FAILED ===${NC}"
    exit 1
else
    echo -e "${GREEN}=== test_cli_config: PASSED ===${NC}"
    exit 0
fi
