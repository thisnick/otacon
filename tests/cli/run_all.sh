#!/usr/bin/env bash
# Run all Phase 2 CLI + admin DELETE tests.
# Usage: ./run_all.sh
# Requires: OTACON_ADMIN_TOKEN and optionally OTACON_REGISTRY_URL

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

TESTS=(
    # Admin DELETE endpoints (curl-based, no CLI needed)
    test_admin_delete_phone.sh
    test_admin_delete_host.sh
    test_admin_delete_dongle.sh
    # CLI build
    test_cli_build.sh
    # CLI config
    test_cli_config.sh
    # CLI auth flow
    test_cli_auth_flow.sh
    # CLI commands
    test_cli_phone_commands.sh
    test_cli_reg_commands.sh
    test_cli_host_commands.sh
    # Type generation
    test_registry_types_generation.sh
)

PASSED=0
FAILED=0
FAILED_NAMES=()

echo "========================================"
echo " Phase 2: CLI + Admin DELETE Tests"
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
