#!/usr/bin/env bash
# Hardware test: Redeploying registry preserves data
#
# Verifies:
#   1. Captures initial registry data (hosts, phones)
#   2. Runs make registry-deploy HOST=otacon-pi (fresh build + push + restart)
#   3. Verifies data files still contain same entries after redeploy
#
# Usage: ./test_redeploy_no_data_loss.sh
# Requires: curl, jq, ssh access to otacon-pi, make

set -euo pipefail

PI="nick@otacon-pi"
REGISTRY_URL="http://otacon-pi.tail0437b8.ts.net:9080"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RESTART_WAIT=30

echo "=== Test: redeploy no data loss ==="

# --- Step 1: Capture initial state ---
echo ""
echo "--- Capturing initial state ---"
HOSTS_BEFORE=$(curl -sf "$REGISTRY_URL/api/v1/hosts" || echo "[]")
PHONES_BEFORE=$(curl -sf "$REGISTRY_URL/api/v1/phones" || echo "[]")

HOST_COUNT_BEFORE=$(echo "$HOSTS_BEFORE" | jq 'length')
PHONE_COUNT_BEFORE=$(echo "$PHONES_BEFORE" | jq 'length')

# Capture host IDs for comparison (using registry_id per dual-ID rule)
HOST_IDS_BEFORE=$(echo "$HOSTS_BEFORE" | jq -c '[.[].id // .[].registry_id] | sort')
PHONE_IDS_BEFORE=$(echo "$PHONES_BEFORE" | jq -c '[.[].registry_id // .[].id] | sort')

echo "Hosts before: $HOST_COUNT_BEFORE (IDs: $HOST_IDS_BEFORE)"
echo "Phones before: $PHONE_COUNT_BEFORE (IDs: $PHONE_IDS_BEFORE)"

# --- Step 2: Run make registry-deploy ---
echo ""
echo "--- Running make registry-deploy HOST=otacon-pi ---"
cd "$REPO_ROOT"
make registry-deploy HOST=otacon-pi 2>&1 | tail -20
echo "Deploy completed."

# --- Step 3: Wait for registry to come back up ---
echo ""
echo "--- Waiting ${RESTART_WAIT}s for registry to come back up ---"
RETRY=0
MAX_RETRY=10
while [ "$RETRY" -lt "$MAX_RETRY" ]; do
    sleep 5
    HOSTS_AFTER=$(curl -sf "$REGISTRY_URL/api/v1/hosts" 2>/dev/null || echo "")
    if [ -n "$HOSTS_AFTER" ]; then
        break
    fi
    RETRY=$((RETRY + 1))
    echo "  Registry not ready yet ($RETRY/$MAX_RETRY)..."
done

if [ -z "$HOSTS_AFTER" ]; then
    echo "FAIL: registry did not come back up after redeploy"
    exit 1
fi

PHONES_AFTER=$(curl -sf "$REGISTRY_URL/api/v1/phones" || echo "[]")

HOST_COUNT_AFTER=$(echo "$HOSTS_AFTER" | jq 'length')
PHONE_COUNT_AFTER=$(echo "$PHONES_AFTER" | jq 'length')

HOST_IDS_AFTER=$(echo "$HOSTS_AFTER" | jq -c '[.[].id // .[].registry_id] | sort')
PHONE_IDS_AFTER=$(echo "$PHONES_AFTER" | jq -c '[.[].registry_id // .[].id] | sort')

echo "Hosts after: $HOST_COUNT_AFTER (IDs: $HOST_IDS_AFTER)"
echo "Phones after: $PHONE_COUNT_AFTER (IDs: $PHONE_IDS_AFTER)"

# --- Step 4: Compare ---
echo ""
echo "--- Comparing data ---"

if [ "$HOST_COUNT_AFTER" -lt "$HOST_COUNT_BEFORE" ]; then
    echo "FAIL: host count dropped from $HOST_COUNT_BEFORE to $HOST_COUNT_AFTER"
    exit 1
fi
echo "PASS: host count preserved ($HOST_COUNT_BEFORE -> $HOST_COUNT_AFTER)"

if [ "$PHONE_COUNT_AFTER" -lt "$PHONE_COUNT_BEFORE" ]; then
    echo "FAIL: phone count dropped from $PHONE_COUNT_BEFORE to $PHONE_COUNT_AFTER"
    exit 1
fi
echo "PASS: phone count preserved ($PHONE_COUNT_BEFORE -> $PHONE_COUNT_AFTER)"

if [ "$HOST_IDS_BEFORE" != "$HOST_IDS_AFTER" ]; then
    echo "FAIL: host IDs changed after redeploy"
    echo "  Before: $HOST_IDS_BEFORE"
    echo "  After:  $HOST_IDS_AFTER"
    exit 1
fi
echo "PASS: host IDs unchanged"

if [ "$PHONE_IDS_BEFORE" != "$PHONE_IDS_AFTER" ]; then
    echo "FAIL: phone IDs changed after redeploy"
    echo "  Before: $PHONE_IDS_BEFORE"
    echo "  After:  $PHONE_IDS_AFTER"
    exit 1
fi
echo "PASS: phone IDs unchanged"

echo ""
echo "=== Test: redeploy no data loss PASSED ==="
