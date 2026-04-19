#!/usr/bin/env bash
# Run all registry hardware sign-off tests in sequence.
# Exits on first failure.
#
# Usage: ./tests/registry/hardware/run_all.sh

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

TESTS=(
    "$DIR/test_registry_on_pi_responds.sh"
    "$DIR/test_port_no_collision.sh"
    "$DIR/test_fleet_node_reports_to_registry.sh"
    "$DIR/test_registry_data_persists.sh"
    "$DIR/test_registry_ui.sh"
    # verify_clean must be last
    "$DIR/verify_clean_registry.sh"
)

PASSED=0
FAILED=0

for test_cmd in "${TESTS[@]}"; do
    echo ""
    echo "========================================"
    echo "Running: $(basename "$test_cmd")"
    echo "========================================"
    if bash "$test_cmd"; then
        PASSED=$((PASSED + 1))
    else
        FAILED=$((FAILED + 1))
        echo "STOPPING: $(basename "$test_cmd") failed"
        break
    fi
done

echo ""
echo "========================================"
echo "Registry hardware tests: $PASSED passed, $FAILED failed"
echo "========================================"
exit "$FAILED"
