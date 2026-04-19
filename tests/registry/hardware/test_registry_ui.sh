#!/usr/bin/env bash
# Hardware test: Registry serves a UI dashboard at /
#
# Verifies:
#   1. GET / returns HTTP 200
#   2. Response contains data-testid="otacon-registry-ui" marker
#
# Usage: ./test_registry_ui.sh
# Requires: curl

set -euo pipefail

source "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/lib/tailscale.sh"

echo "=== Test: registry UI ==="

# --- Step 1: Check / returns 200 ---
echo ""
echo "--- Checking $REGISTRY_URL/ ---"
HTTP_CODE=$(curl -so /dev/null -w "%{http_code}" "$REGISTRY_URL/" 2>/dev/null)

if [ "$HTTP_CODE" != "200" ]; then
    echo "FAIL: GET / returned HTTP $HTTP_CODE (expected 200)"
    exit 1
fi
echo "PASS: GET / returns HTTP 200"

# --- Step 2: Check response contains UI marker ---
BODY=$(curl -sf "$REGISTRY_URL/" 2>/dev/null || echo "")

if [ -z "$BODY" ]; then
    echo "FAIL: GET / returned empty body"
    exit 1
fi

if ! echo "$BODY" | grep -q 'data-testid="otacon-registry-ui"'; then
    echo "FAIL: response does not contain data-testid=\"otacon-registry-ui\" marker"
    echo "  First 200 chars: $(echo "$BODY" | head -c 200)"
    exit 1
fi
echo "PASS: response contains data-testid=\"otacon-registry-ui\" marker"

echo ""
echo "=== Test: registry UI PASSED ==="
