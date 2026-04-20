#!/usr/bin/env bash
# Run all heartbeat tests.
# Usage: bash run_all.sh
# Requires: OTACON_ADMIN_TOKEN environment variable

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

failed=0
passed=0
tests=(
    "test_heartbeat_liveness.sh"
    "test_phone_reachability.sh"
    "test_restart_survival.sh"
)

for test in "${tests[@]}"; do
    echo ""
    echo "================================================================"
    echo "Running: $test"
    echo "================================================================"
    if bash "$SCRIPT_DIR/$test"; then
        passed=$((passed + 1))
    else
        failed=$((failed + 1))
    fi
done

echo ""
echo "================================================================"
echo -e "Results: ${GREEN}$passed passed${NC}, ${RED}$failed failed${NC}"
echo "================================================================"

exit "$failed"
