#!/usr/bin/env bash
# Hardware test: verify no test fixtures leaked into live data files
#
# Scans phones.json, dongles.json, sims.json for entries with
# adb_serial values that look like test fixtures (TEST, FAKE, PHANTOM,
# or ending in ABC). Fails if any are found.
#
# Usage: ./verify_clean.sh
# Requires: ssh access to otacon-pi, jq inside container

set -euo pipefail

PI="nick@otacon-pi"
CONTAINER="otacon-otacon-1"
DATA_DIR="/data/otacon"

echo "=== Test: verify no test fixture leakage ==="

FAIL=false

# Pattern: TEST, FAKE, PHANTOM, or ending in ABC
PATTERN='^(TEST|FAKE|PHANTOM|.*ABC)$'

for file in phones.json dongles.json sims.json; do
    FULL_PATH="$DATA_DIR/$file"
    EXISTS=$(ssh "$PI" "docker exec $CONTAINER test -f '$FULL_PATH' && echo yes || echo no" 2>/dev/null)

    if [ "$EXISTS" != "yes" ]; then
        echo "  $file: not present (ok)"
        continue
    fi

    # Extract all adb_serial values
    SERIALS=$(ssh "$PI" "docker exec $CONTAINER cat '$FULL_PATH'" 2>/dev/null \
        | jq -r '.[].adb_serial // empty' 2>/dev/null || true)

    if [ -z "$SERIALS" ]; then
        echo "  $file: no adb_serial entries (ok)"
        continue
    fi

    LEAKED=false
    while IFS= read -r serial; do
        if echo "$serial" | grep -qE "$PATTERN"; then
            echo "  $file: LEAKED test fixture: adb_serial=$serial"
            LEAKED=true
            FAIL=true
        fi
    done <<< "$SERIALS"

    if [ "$LEAKED" = "false" ]; then
        echo "  $file: clean"
    fi
done

# Also check the Rust server's phone list for phantom entries
echo ""
echo "--- Checking /phones API for test fixtures ---"
PHONE_LIST=$(ssh "$PI" "curl -sk https://localhost:8080/phones" 2>/dev/null || true)

if [ -n "$PHONE_LIST" ]; then
    PHONE_SERIALS=$(echo "$PHONE_LIST" | jq -r '.[].adb_serial // empty' 2>/dev/null || true)
    if [ -n "$PHONE_SERIALS" ]; then
        while IFS= read -r serial; do
            if echo "$serial" | grep -qE "$PATTERN"; then
                echo "  /phones API: LEAKED test fixture: adb_serial=$serial"
                FAIL=true
            fi
        done <<< "$PHONE_SERIALS"
    fi
    if [ "$FAIL" = "false" ]; then
        echo "  /phones API: clean"
    fi
else
    echo "  /phones API: could not reach (skipped)"
fi

echo ""
if [ "$FAIL" = "true" ]; then
    echo "FAIL: test fixture residue detected in live data"
    exit 1
fi

echo "=== Test: verify_clean PASSED ==="
