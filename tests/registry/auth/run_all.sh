#!/usr/bin/env bash
# Run all auth tests for the control-plane-split phase.
#
# Usage:
#   export OTACON_ADMIN_TOKEN=otc_admin_...
#   ./run_all.sh
#
# Optional env vars:
#   OTACON_REGISTRY_URL  -- override registry URL (default: derived from tailscale)
#   OTACON_ADMIN_URL     -- override admin URL (default: http://otacon-pi:9090)
#   SKIP_SLOW            -- skip tests that take >30s (long-poll timeout)
#   SKIP_DESTRUCTIVE     -- skip tests that restart containers (bootstrap token)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

TESTS=(
    "test_full_registration.sh"
    "test_node_token_cant_call_admin.sh"
    "test_admin_token_cant_call_node.sh"
    "test_no_auth_rejected.sh"
    "test_invalid_token_rejected.sh"
    "test_revoked_token_rejected.sh"
    "test_bootstrap_admin_token.sh"
    "test_only_registry_on_tailnet.sh"
    "test_port_isolation.sh"
    "test_registration_spam_rate_limited.sh"
    "test_token_not_logged_after_first_print.sh"
    "test_long_poll_timeout.sh"
    "test_long_poll_rejection.sh"
    "test_concurrent_registrations.sh"
)

SLOW_TESTS=(
    "test_long_poll_timeout.sh"
    "test_bootstrap_admin_token.sh"
)

DESTRUCTIVE_TESTS=(
    "test_bootstrap_admin_token.sh"
)

PASSED=0
FAILED=0
SKIPPED=0
RESULTS=()

is_in_array() {
    local needle="$1"
    shift
    for item in "$@"; do
        [ "$item" = "$needle" ] && return 0
    done
    return 1
}

echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}  Auth Test Suite - Control Plane Split  ${NC}"
echo -e "${BOLD}========================================${NC}"
echo ""

for test in "${TESTS[@]}"; do
    # Skip checks
    if [ "${SKIP_SLOW:-}" = "1" ] && is_in_array "$test" "${SLOW_TESTS[@]}"; then
        echo -e "${YELLOW}[SKIP]${NC} $test (SKIP_SLOW=1)"
        SKIPPED=$((SKIPPED + 1))
        RESULTS+=("SKIP $test")
        continue
    fi

    if [ "${SKIP_DESTRUCTIVE:-}" = "1" ] && is_in_array "$test" "${DESTRUCTIVE_TESTS[@]}"; then
        echo -e "${YELLOW}[SKIP]${NC} $test (SKIP_DESTRUCTIVE=1)"
        SKIPPED=$((SKIPPED + 1))
        RESULTS+=("SKIP $test")
        continue
    fi

    echo ""
    echo -e "${BOLD}>>> Running: $test${NC}"
    if bash "$SCRIPT_DIR/$test"; then
        PASSED=$((PASSED + 1))
        RESULTS+=("PASS $test")
    else
        FAILED=$((FAILED + 1))
        RESULTS+=("FAIL $test")
    fi
done

# Also run cargo unit tests if available
echo ""
echo -e "${BOLD}>>> Running: cargo test (registry unit tests)${NC}"
REGISTRY_DIR="$SCRIPT_DIR/../../../src/registry"
if [ -d "$REGISTRY_DIR" ]; then
    if (cd "$REGISTRY_DIR" && cargo test 2>&1); then
        PASSED=$((PASSED + 1))
        RESULTS+=("PASS cargo_test")
    else
        FAILED=$((FAILED + 1))
        RESULTS+=("FAIL cargo_test")
    fi
else
    echo "  Registry source not found at $REGISTRY_DIR"
    SKIPPED=$((SKIPPED + 1))
    RESULTS+=("SKIP cargo_test")
fi

# Summary
echo ""
echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}  SUMMARY${NC}"
echo -e "${BOLD}========================================${NC}"
for result in "${RESULTS[@]}"; do
    STATUS="${result%% *}"
    NAME="${result#* }"
    case "$STATUS" in
        PASS) echo -e "  ${GREEN}[PASS]${NC} $NAME" ;;
        FAIL) echo -e "  ${RED}[FAIL]${NC} $NAME" ;;
        SKIP) echo -e "  ${YELLOW}[SKIP]${NC} $NAME" ;;
    esac
done
echo ""
echo -e "  Passed: ${GREEN}$PASSED${NC}  Failed: ${RED}$FAILED${NC}  Skipped: ${YELLOW}$SKIPPED${NC}"
echo ""

if [ "$FAILED" -gt 0 ]; then
    echo -e "${RED}OVERALL: FAIL${NC}"
    exit 1
else
    echo -e "${GREEN}OVERALL: PASS${NC}"
    exit 0
fi
