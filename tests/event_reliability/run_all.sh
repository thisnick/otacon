#!/usr/bin/env bash
# Run all Phase 5 event reliability tests.
#
# Usage:
#   export OTACON_ADMIN_TOKEN=otc_admin_...
#   ./tests/event_reliability/run_all.sh [--5a-only] [--no-restart]
#
# Options:
#   --5a-only     Only run Phase 5a (heartbeat hot fix) tests
#   --no-restart  Skip tests that restart containers

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

FIVE_A_ONLY=false
NO_RESTART=false
for arg in "$@"; do
    case "$arg" in
        --5a-only)   FIVE_A_ONLY=true ;;
        --no-restart) NO_RESTART=true ;;
    esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

TOTAL=0
PASSED=0
FAILED=0
SKIPPED=0

run_test() {
    local name="$1" script="$2"
    TOTAL=$((TOTAL + 1))
    echo ""
    echo -e "${YELLOW}======================================${NC}"
    echo -e "${YELLOW}Running: $name${NC}"
    echo -e "${YELLOW}======================================${NC}"
    if bash "$script"; then
        PASSED=$((PASSED + 1))
    else
        FAILED=$((FAILED + 1))
    fi
}

skip_test() {
    local name="$1" reason="$2"
    TOTAL=$((TOTAL + 1))
    SKIPPED=$((SKIPPED + 1))
    echo ""
    echo -e "${YELLOW}[SKIP]${NC} $name — $reason"
}

echo "=== Phase 5 Event Reliability Test Suite ==="
echo ""

# Phase 5a tests
run_test "5a: Heartbeat phone status" "$SCRIPT_DIR/test_5a_heartbeat_phone_status.sh"

if [ "$NO_RESTART" = true ]; then
    skip_test "5a: Host restart" "--no-restart flag"
    skip_test "5a: Registry restart" "--no-restart flag"
else
    run_test "5a: Host restart (no flicker)" "$SCRIPT_DIR/test_5a_host_restart.sh"
    run_test "5a: Registry restart" "$SCRIPT_DIR/test_5a_registry_restart.sh"
fi

if [ "$FIVE_A_ONLY" = true ]; then
    echo ""
    echo "--- Skipping Phase 5b/5c/5d tests (--5a-only) ---"
else
    # Phase 5b/5c/5d tests (non-interactive)
    run_test "5bcd: Outbox inspection" "$SCRIPT_DIR/test_5bcd_outbox_inspect.sh"
    run_test "5bcd: Idempotency" "$SCRIPT_DIR/test_5bcd_idempotency.sh"
    run_test "5: Migration" "$SCRIPT_DIR/test_5_migration.sh"

    if [ "$NO_RESTART" = true ]; then
        skip_test "5bcd: Registry-down recovery" "--no-restart flag"
        skip_test "5bcd: Host-down recovery" "--no-restart flag"
    else
        run_test "5bcd: Registry-down recovery" "$SCRIPT_DIR/test_5bcd_registry_down_recovery.sh"
        run_test "5bcd: Host-down recovery" "$SCRIPT_DIR/test_5bcd_host_down_recovery.sh"
    fi

    # Interactive tests (phone plug/unplug) are not included in run_all.
    # Run them manually:
    echo ""
    echo -e "${YELLOW}NOTE:${NC} Interactive tests not included in run_all (require physical action):"
    echo "  - test_5bcd_phone_discovery.sh [ADB_SERIAL]"
    echo "  - test_5bcd_phone_disconnect.sh <REGISTRY_PHONE_ID>"
fi

# Summary
echo ""
echo "========================================="
echo "Summary: $PASSED passed, $FAILED failed, $SKIPPED skipped (of $TOTAL)"
echo "========================================="

if [ "$FAILED" -gt 0 ]; then
    echo -e "${RED}SUITE FAILED${NC}"
    exit 1
else
    echo -e "${GREEN}SUITE PASSED${NC}"
    exit 0
fi
