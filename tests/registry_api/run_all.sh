#!/usr/bin/env bash
# Run all Phase 1 registry API restructure tests.
# Usage: ./run_all.sh
# Requires: OTACON_ADMIN_TOKEN and optionally OTACON_REGISTRY_URL

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

TESTS=(
    test_old_paths_return_404.sh
    test_host_registration_flow.sh
    test_client_registration_flow.sh
    test_registration_reject.sh
    test_new_node_scope_paths.sh
    test_new_admin_scope_paths.sh
    test_openapi_spec.sh
    test_admin_ui.sh
    test_single_binary.sh
)

PASSED=0
FAILED=0
FAILED_NAMES=()

echo "========================================"
echo " Phase 1: Registry API Restructure Tests"
echo "========================================"
echo ""

for test in "${TESTS[@]}"; do
    echo "--- Running $test ---"
    if bash "$SCRIPT_DIR/$test"; then
        PASSED=$((PASSED + 1))
    else
        FAILED=$((FAILED + 1))
        FAILED_NAMES+=("$test")
    fi
    echo ""
done

echo "========================================"
echo " Results: $PASSED passed, $FAILED failed"
echo "========================================"

if [ $FAILED -gt 0 ]; then
    echo ""
    echo -e "${RED}Failed tests:${NC}"
    for name in "${FAILED_NAMES[@]}"; do
        echo "  - $name"
    done
    exit 1
else
    echo ""
    echo -e "${GREEN}All tests passed.${NC}"
    exit 0
fi
