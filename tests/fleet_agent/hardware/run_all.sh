#!/usr/bin/env bash
# Run all hardware sign-off tests in sequence.
# Exits on first failure. Run from repo root or pass REPO_ROOT as $1.
#
# Usage: ./tests/fleet_agent/hardware/run_all.sh

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../../.." && pwd)"

TESTS=(
    "$DIR/test_supervisord.sh"
    "$DIR/test_phones_discovered.sh"
    "$DIR/test_monitor_status.sh"
    "$DIR/test_s22_self_heal.sh"
    "$DIR/test_fleet_cli.sh"
    "$DIR/test_registry_heartbeats.sh"
    "$DIR/test_no_regressions.sh"
    "$DIR/test_source_checks.sh $REPO"
    "$DIR/test_full_restrictions.sh"
    "$DIR/test_asymmetric_pair_fallthrough.sh"
    "$DIR/test_auto_tap_watcher.sh"
    "$DIR/test_post_pair_restriction_reapply.sh"
    "$DIR/test_factory_reset_full_recovery.sh"
    "$DIR/test_bt_silence.sh"
    # Phase 3: resilience / auto-reassign tests
    "$DIR/test_transient_phone_disconnect.sh"
    "$DIR/test_transient_dongle_disconnect.sh"
    "$DIR/test_permanent_phone_loss.sh"
    "$DIR/test_permanent_dongle_loss.sh"
    "$DIR/test_replug_after_cutoff.sh"
    "$DIR/test_host_failure_detection.sh"
    "$DIR/test_bt_reconnect_after_reboot.sh"
    # verify_clean must be last
    "$DIR/verify_clean.sh"
)

PASSED=0
FAILED=0

for test_cmd in "${TESTS[@]}"; do
    echo ""
    echo "========================================"
    echo "Running: $test_cmd"
    echo "========================================"
    if bash -c "$test_cmd"; then
        PASSED=$((PASSED + 1))
    else
        FAILED=$((FAILED + 1))
        echo "STOPPING: $test_cmd failed"
        break
    fi
done

echo ""
echo "========================================"
echo "Results: $PASSED passed, $FAILED failed"
echo "========================================"
exit "$FAILED"
