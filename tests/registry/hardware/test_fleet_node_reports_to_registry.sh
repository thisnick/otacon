#!/usr/bin/env bash
# Hardware test: Fleet-node on Pi reports to Pi-hosted registry
#
# Verifies:
#   1. /api/v1/hosts shows otacon-pi with recent last_heartbeat (within 60s)
#   2. /api/v1/phones shows all 3 phones
#   3. /api/v1/dongles shows 4 dongles
#   4. After 90s wait, last_heartbeat has advanced
#
# Usage: ./test_fleet_node_reports_to_registry.sh
# Requires: curl, jq

set -euo pipefail

REGISTRY_URL="http://otacon-pi:9080"
HEARTBEAT_WAIT=90

echo "=== Test: fleet-node reports to Pi-hosted registry ==="

# --- Step 1: Check hosts for otacon-pi with recent heartbeat ---
echo ""
echo "--- Checking hosts ---"
HOSTS=$(curl -sf "$REGISTRY_URL/api/v1/hosts" || echo "[]")
HOST_COUNT=$(echo "$HOSTS" | jq 'length')

if [ "$HOST_COUNT" -eq 0 ]; then
    echo "FAIL: no hosts registered in registry"
    exit 1
fi

# Find otacon-pi entry
PI_ENTRY=$(echo "$HOSTS" | jq '[.[] | select(.id == "otacon-pi")] | .[0] // empty')
if [ -z "$PI_ENTRY" ] || [ "$PI_ENTRY" = "null" ]; then
    echo "FAIL: no host entry for otacon-pi"
    echo "  Available hosts: $(echo "$HOSTS" | jq -c '[.[].id]')"
    exit 1
fi

HB1=$(echo "$PI_ENTRY" | jq -r '.last_heartbeat // empty')
HOST_ID=$(echo "$PI_ENTRY" | jq -r '.id // .registry_id // empty')
echo "Host: $HOST_ID"
echo "Last heartbeat: $HB1"

if [ -z "$HB1" ]; then
    echo "FAIL: otacon-pi has no last_heartbeat"
    exit 1
fi

# Check heartbeat is within 60s of now
NOW=$(date +%s)
# Handle ISO 8601 timestamps
HB_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$(echo "$HB1" | sed 's/\..*//' | sed 's/Z$//')" "+%s" 2>/dev/null || \
           date -d "$HB1" "+%s" 2>/dev/null || echo "0")
if [ "$HB_EPOCH" -ne 0 ]; then
    AGE=$((NOW - HB_EPOCH))
    if [ "$AGE" -gt 60 ]; then
        echo "FAIL: heartbeat is ${AGE}s old (>60s threshold)"
        exit 1
    fi
    echo "PASS: heartbeat age is ${AGE}s (within 60s)"
else
    echo "WARN: could not parse heartbeat timestamp for age check"
fi

# --- Step 2: Check phones ---
echo ""
echo "--- Checking phones ---"
PHONES=$(curl -sf "$REGISTRY_URL/api/v1/phones" || echo "[]")
PHONE_COUNT=$(echo "$PHONES" | jq 'length')
echo "Phone count: $PHONE_COUNT"

if [ "$PHONE_COUNT" -lt 3 ]; then
    echo "FAIL: expected >= 3 phones, got $PHONE_COUNT"
    echo "  Phones: $(echo "$PHONES" | jq -c '[.[].adb_serial]')"
    exit 1
fi
echo "PASS: >= 3 phones registered"

# --- Step 3: Check dongles ---
echo ""
echo "--- Checking dongles ---"
DONGLES=$(curl -sf "$REGISTRY_URL/api/v1/dongles" || echo "[]")
DONGLE_COUNT=$(echo "$DONGLES" | jq 'length')
echo "Dongle count: $DONGLE_COUNT"

if [ "$DONGLE_COUNT" -lt 4 ]; then
    echo "FAIL: expected >= 4 dongles, got $DONGLE_COUNT"
    exit 1
fi
echo "PASS: >= 4 dongles registered"

# --- Step 4: Wait and verify heartbeat advances ---
echo ""
echo "--- Waiting ${HEARTBEAT_WAIT}s for heartbeat to advance ---"
sleep "$HEARTBEAT_WAIT"

HOSTS2=$(curl -sf "$REGISTRY_URL/api/v1/hosts" || echo "[]")
PI_ENTRY2=$(echo "$HOSTS2" | jq '[.[] | select(.id == "otacon-pi")] | .[0] // empty')
HB2=$(echo "$PI_ENTRY2" | jq -r '.last_heartbeat // empty')
echo "Updated heartbeat: $HB2"

if [ "$HB1" = "$HB2" ]; then
    echo "FAIL: heartbeat did not advance after ${HEARTBEAT_WAIT}s"
    exit 1
fi
echo "PASS: heartbeat advanced from $HB1 to $HB2"

echo ""
echo "=== Test: fleet-node reports to registry PASSED ==="
