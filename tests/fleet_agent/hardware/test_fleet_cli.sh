#!/usr/bin/env bash
# Hardware test 8: fleet-cli works manually
#
# Usage: ./test_fleet_cli.sh
# Requires: ssh access to otacon-pi

set -euo pipefail

PI="nick@otacon-pi"
CONTAINER="otacon-otacon-1"

echo "=== Test 8: fleet-cli manual ops ==="

# Test phone status command (with --phone since multi-device requires it)
echo "--- fleet-cli phone status --phone 14151JEC200486 ---"
STATUS=$(ssh "$PI" "docker exec $CONTAINER /opt/fleet-cli phone status --phone 14151JEC200486" 2>&1)
echo "$STATUS"

if echo "$STATUS" | grep -qE '(Health|Phone):'; then
    echo "PASS: fleet-cli phone status returned health output"
else
    echo "FAIL: fleet-cli phone status did not return expected output"
    exit 1
fi

# Test single check command (check names use underscores, not hyphens)
echo ""
echo "--- fleet-cli check run --check bt_bonded ---"
CHECK=$(ssh "$PI" "docker exec $CONTAINER /opt/fleet-cli check run --phone 14151JEC200486 --check bt_bonded" 2>&1 || true)
echo "$CHECK"

# Accept OK or FAIL as valid output (both mean the CLI worked)
if echo "$CHECK" | grep -qE '(OK|FAIL)'; then
    echo "PASS: fleet-cli check run returned valid result"
else
    echo "FAIL: fleet-cli check run did not return OK or FAIL"
    exit 1
fi

echo "=== Test 8 PASSED ==="
