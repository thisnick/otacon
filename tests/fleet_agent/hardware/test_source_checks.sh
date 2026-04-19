#!/usr/bin/env bash
# Hardware test 11: Source spot-checks
# Verifies the repo state: new package exists, old files deleted, supervisord updated.
#
# Usage: ./test_source_checks.sh [REPO_ROOT]
# Can run locally or in CI -- no Pi required.

set -euo pipefail

REPO="${1:-$(cd "$(dirname "$0")/../../.." && pwd)}"

echo "=== Test 11: Source spot-checks ==="

# fleet_agent package exists with expected structure
EXPECTED_DIRS="src/fleet_agent src/fleet_agent/phone src/fleet_agent/bluetooth src/fleet_agent/steps src/fleet_agent/registry src/fleet_agent/util"
for dir in $EXPECTED_DIRS; do
    if [ -d "$REPO/$dir" ]; then
        echo "  PASS: $dir/ exists"
    else
        echo "  FAIL: $dir/ missing"
        exit 1
    fi
done

# Old files are deleted
DELETED_FILES="scripts/device-monitor.py scripts/bluetooth-agent.py scripts/bt-reconnect.py scripts/bluetooth-pair.sh scripts/bluetooth-connect.sh scripts/bluetooth-status.sh scripts/bluetooth-repair.sh"
for f in $DELETED_FILES; do
    if [ -e "$REPO/$f" ]; then
        echo "  FAIL: $f still exists (should be deleted)"
        exit 1
    else
        echo "  PASS: $f deleted"
    fi
done

# Old package location must not exist (moved to src/)
if [ -d "$REPO/scripts/fleet_agent" ]; then
    echo "  FAIL: scripts/fleet_agent/ still exists (should be moved to src/fleet_agent/)"
    exit 1
else
    echo "  PASS: scripts/fleet_agent/ removed (moved to src/)"
fi

# fleet-cli exists and is executable (or at least exists)
if [ -f "$REPO/src/fleet-cli" ]; then
    echo "  PASS: src/fleet-cli exists"
else
    echo "  FAIL: src/fleet-cli missing"
    exit 1
fi

# wifi-monitor.sh unchanged (still present)
if [ -f "$REPO/scripts/wifi-monitor.sh" ]; then
    echo "  PASS: scripts/wifi-monitor.sh still present"
else
    echo "  FAIL: scripts/wifi-monitor.sh missing (should be unchanged)"
    exit 1
fi

# supervisord references fleet-agent, not device-monitor
SUPERVISORD="$REPO/config/supervisord-base.conf"
if [ -f "$SUPERVISORD" ]; then
    if grep -q 'fleet-agent' "$SUPERVISORD"; then
        echo "  PASS: supervisord-base.conf references fleet-agent"
    else
        echo "  FAIL: supervisord-base.conf does not reference fleet-agent"
        exit 1
    fi
    if grep -q 'device-monitor' "$SUPERVISORD"; then
        echo "  FAIL: supervisord-base.conf still references device-monitor"
        exit 1
    else
        echo "  PASS: supervisord-base.conf does not reference device-monitor"
    fi
else
    echo "  WARN: supervisord-base.conf not found at $SUPERVISORD"
fi

echo "=== Test 11 PASSED ==="
