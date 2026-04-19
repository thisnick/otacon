#!/usr/bin/env bash
# Hardware test 4+5+6: Monitor status surfaced, setup steps tracked, health checks running
#
# Usage: ./test_monitor_status.sh [PHONE_ID]
# Requires: curl, jq, access to otacon-pi:8080

set -euo pipefail

source "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/lib/tailscale.sh"
PHONE_ID="${1:-phone-14151jec}"

echo "=== Test 4: Monitor status surfaced in /api/info ==="

INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
MONITOR=$(echo "$INFO" | jq '.monitor')

if [ "$MONITOR" = "null" ] || [ -z "$MONITOR" ]; then
    echo "FAIL: .monitor is null or missing in /api/info for $PHONE_ID"
    echo "Raw response: $INFO"
    exit 1
fi
echo "PASS: .monitor is non-null"

# Check required fields
REQUIRED_FIELDS="phase setup health heals loop_iteration last_check_at"
for field in $REQUIRED_FIELDS; do
    VAL=$(echo "$MONITOR" | jq ".$field")
    if [ "$VAL" = "null" ] && [ "$field" != "last_check_at" ]; then
        echo "FAIL: .monitor.$field is null"
        exit 1
    fi
    echo "  $field: $VAL"
done
echo "PASS: all required fields present"

echo ""
echo "=== Test 5: Setup steps tracked ==="

SETUP=$(echo "$MONITOR" | jq '.setup')
echo "Setup steps:"
echo "$SETUP" | jq -r 'to_entries[] | "  \(.key): succeeded=\(.value.succeeded)"'

# Check all steps succeeded for the known-good phone
FAILED=$(echo "$SETUP" | jq -r 'to_entries[] | select(.value.succeeded == false) | .key')
if [ -n "$FAILED" ]; then
    echo "FAIL: steps with succeeded=false: $FAILED"
    exit 1
fi
echo "PASS: all setup steps succeeded"

echo ""
echo "=== Test 6: Health checks running ==="

HEALTH=$(echo "$MONITOR" | jq '.health')
echo "Health checks:"
echo "$HEALTH" | jq -r 'to_entries[] | "  \(.key): \(.value)"'

# Verify expected checks present
EXPECTED_CHECKS="bt_bonded bt_connected wifi device_owner snapshot_alive"
for check in $EXPECTED_CHECKS; do
    VAL=$(echo "$HEALTH" | jq ".$check")
    if [ "$VAL" = "null" ]; then
        echo "FAIL: health check '$check' missing"
        exit 1
    fi
done
echo "PASS: all expected health checks present"

echo "=== Tests 4+5+6 PASSED ==="
