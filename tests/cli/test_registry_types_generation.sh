#!/usr/bin/env bash
# Test: registry-types.ts generation from OpenAPI spec.
# Verifies the npm run generate:registry script produces registry-types.ts.

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

echo "=== Test: registry-types.ts generation ==="

CLI_DIR="$REPO_ROOT/src/cli"

# --- Test 1: generate:registry script exists in package.json ---
echo ""
echo "--- Check generate:registry script in package.json ---"
if grep -q '"generate:registry"' "$CLI_DIR/package.json"; then
    pass "generate:registry script defined in package.json"
else
    fail "generate_script" "generate:registry script not found in package.json"
fi

# --- Test 2: Registry OpenAPI spec exists ---
echo ""
echo "--- Check registry OpenAPI spec ---"
SPEC_PATH="$REPO_ROOT/docs/openapi/registry.json"
if [ -f "$SPEC_PATH" ]; then
    pass "Registry OpenAPI spec exists at docs/openapi/registry.json"

    # Validate it's valid JSON
    if jq empty "$SPEC_PATH" 2>/dev/null; then
        pass "Registry OpenAPI spec is valid JSON"
    else
        fail "spec_valid_json" "Registry OpenAPI spec is not valid JSON"
    fi

    # Check it has paths
    PATH_COUNT=$(jq '.paths | length' "$SPEC_PATH" 2>/dev/null || echo "0")
    observe "Spec has $PATH_COUNT paths"
    if [ "$PATH_COUNT" -gt 0 ]; then
        pass "Spec has $PATH_COUNT API paths defined"
    else
        fail "spec_paths" "Spec has no paths defined"
    fi
else
    observe "Registry OpenAPI spec not found at $SPEC_PATH"
    observe "Checking if spec is served at runtime..."

    # Try to fetch from live registry
    source "$REPO_ROOT/scripts/lib/tailscale.sh"
    REGISTRY_FQDN=$(ts_fqdn "otacon-registry")
    REGISTRY_URL="${OTACON_REGISTRY_URL:-http://${REGISTRY_FQDN}:9080}"

    SPEC_RESPONSE=$(curl -s -w '\n%{http_code}' "$REGISTRY_URL/api/docs/openapi.json" 2>/dev/null || echo "000")
    SPEC_STATUS=$(echo "$SPEC_RESPONSE" | tail -1)
    if [ "$SPEC_STATUS" = "200" ]; then
        pass "Registry spec served at /api/docs/openapi.json (runtime)"
        observe "Spec file not exported to docs/openapi/ — generate:registry may fail without it"
    else
        fail "spec_missing" "Registry OpenAPI spec not found at $SPEC_PATH or at runtime endpoint"
    fi
fi

# --- Test 3: Run generate:registry if spec exists ---
echo ""
echo "--- npm run generate:registry ---"
cd "$CLI_DIR"
if npm run generate:registry 2>&1; then
    pass "npm run generate:registry succeeded"

    # Check registry-types.ts was created
    if [ -f "$CLI_DIR/src/registry-types.ts" ]; then
        pass "registry-types.ts generated"
        LINE_COUNT=$(wc -l < "$CLI_DIR/src/registry-types.ts" | tr -d ' ')
        observe "registry-types.ts has $LINE_COUNT lines"
    else
        fail "types_file" "registry-types.ts not found after generation"
    fi
else
    fail "generate_run" "npm run generate:registry failed"
fi

# --- Test 4: registry-types.ts is imported somewhere ---
echo ""
echo "--- Check registry-types.ts imports ---"
if grep -r "registry-types" "$CLI_DIR/src/" --include='*.ts' | grep -v "registry-types.ts" | grep -q .; then
    pass "registry-types.ts is imported in CLI source"
else
    observe "registry-types.ts is not imported yet (may be unused)"
fi

echo ""
if [ "$TEST_FAILED" = "true" ]; then
    echo -e "${RED}=== test_registry_types_generation: FAILED ===${NC}"
    exit 1
else
    echo -e "${GREEN}=== test_registry_types_generation: PASSED ===${NC}"
    exit 0
fi
