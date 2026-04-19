#!/usr/bin/env bash
# Hardware test: verify no test fixtures leaked into registry data
#
# Scans registry's phones and dongles endpoints for entries with
# serials that look like test fixtures (TEST, FAKE, PHANTOM, or
# ending in ABC). Fails if any are found.
#
# Usage: ./verify_clean_registry.sh
# Requires: curl, jq

set -euo pipefail

REGISTRY_URL="http://otacon-pi:9080"

echo "=== Test: verify no test fixture leakage in registry ==="

FAIL=false

# Pattern: TEST, FAKE, PHANTOM, or ending in ABC
PATTERN='^(TEST|FAKE|PHANTOM|.*ABC)$'

# --- Check phones ---
echo ""
echo "--- Checking registry /api/v1/phones ---"
PHONES=$(curl -sf "$REGISTRY_URL/api/v1/phones" 2>/dev/null || echo "[]")

PHONE_SERIALS=$(echo "$PHONES" | jq -r '.[].adb_serial // empty' 2>/dev/null || true)
if [ -n "$PHONE_SERIALS" ]; then
    while IFS= read -r serial; do
        [ -z "$serial" ] && continue
        if echo "$serial" | grep -qE "$PATTERN"; then
            echo "  phones: LEAKED test fixture: adb_serial=$serial"
            FAIL=true
        fi
    done <<< "$PHONE_SERIALS"
fi

if [ "$FAIL" = "false" ]; then
    echo "  phones: clean ($(echo "$PHONES" | jq 'length') entries)"
fi

# --- Check dongles ---
echo ""
echo "--- Checking registry /api/v1/dongles ---"
DONGLES=$(curl -sf "$REGISTRY_URL/api/v1/dongles" 2>/dev/null || echo "[]")

DONGLE_SERIALS=$(echo "$DONGLES" | jq -r '.[].serial // empty' 2>/dev/null || true)
if [ -n "$DONGLE_SERIALS" ]; then
    while IFS= read -r serial; do
        [ -z "$serial" ] && continue
        if echo "$serial" | grep -qE "$PATTERN"; then
            echo "  dongles: LEAKED test fixture: serial=$serial"
            FAIL=true
        fi
    done <<< "$DONGLE_SERIALS"
fi

DONGLE_LEAKED=$FAIL
if [ "$DONGLE_LEAKED" = "false" ]; then
    echo "  dongles: clean ($(echo "$DONGLES" | jq 'length') entries)"
fi

# --- Check for empty-ID entries ---
echo ""
echo "--- Checking for empty-ID entries ---"
EMPTY_ID_PHONES=$(echo "$PHONES" | jq '[.[] | select(.id == "" or .id == null)] | length')
EMPTY_ID_DONGLES=$(echo "$DONGLES" | jq '[.[] | select(.id == "" or .id == null)] | length')

if [ "$EMPTY_ID_PHONES" -gt 0 ]; then
    echo "  phones: $EMPTY_ID_PHONES entries with empty/null ID"
    FAIL=true
fi
if [ "$EMPTY_ID_DONGLES" -gt 0 ]; then
    echo "  dongles: $EMPTY_ID_DONGLES entries with empty/null ID"
    FAIL=true
fi

if [ "$EMPTY_ID_PHONES" -eq 0 ] && [ "$EMPTY_ID_DONGLES" -eq 0 ]; then
    echo "  no empty-ID entries found"
fi

echo ""
if [ "$FAIL" = "true" ]; then
    echo "FAIL: test fixture residue detected in registry"
    exit 1
fi

echo "=== Test: verify_clean_registry PASSED ==="
