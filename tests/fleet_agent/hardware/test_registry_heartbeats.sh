#!/usr/bin/env bash
# Hardware test 9: Registry still receiving heartbeats + dongle reports
#
# Usage: ./test_registry_heartbeats.sh
# Requires: curl, jq, registry at localhost:8080

set -euo pipefail

source "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/lib/tailscale.sh"

echo "=== Test 9: Registry heartbeats + dongles ==="

# Get initial heartbeat timestamp
HB1=$(curl -s "$REGISTRY_URL/api/v1/hosts" | jq -r '.[0].last_heartbeat // empty')
if [ -z "$HB1" ]; then
    echo "FAIL: no hosts registered in registry"
    exit 1
fi
echo "Initial heartbeat: $HB1"

# Wait for next heartbeat
echo "Waiting 65s for heartbeat to advance..."
sleep 65

HB2=$(curl -s "$REGISTRY_URL/api/v1/hosts" | jq -r '.[0].last_heartbeat // empty')
echo "Updated heartbeat: $HB2"

if [ "$HB1" = "$HB2" ]; then
    echo "FAIL: heartbeat did not advance after 65s"
    exit 1
fi
echo "PASS: heartbeat advanced"

# Check dongles
DONGLE_COUNT=$(curl -s "$REGISTRY_URL/api/v1/dongles" | jq 'length')
echo "Dongle count: $DONGLE_COUNT"

if [ "$DONGLE_COUNT" -lt 4 ]; then
    echo "FAIL: expected >= 4 dongles, got $DONGLE_COUNT"
    exit 1
fi
echo "PASS: >= 4 dongles registered"

echo "=== Test 9 PASSED ==="
