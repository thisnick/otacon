#!/usr/bin/env bash
# Hardware test 3: All 3 phones discovered and registered
#
# Usage: ./test_phones_discovered.sh
# Requires: curl, jq, access to otacon-pi:8080

set -euo pipefail

PI_URL="https://otacon-pi:8080"
EXPECTED_IDS="phone-r92x1022 phone-r5ct60sd phone-14151jec"

echo "=== Test 3: Phones discovered + registered ==="

PHONES=$(curl -sk "$PI_URL/phones" 2>/dev/null)
COUNT=$(echo "$PHONES" | jq 'length')

echo "Phone count: $COUNT"
echo "$PHONES" | jq -r '.[].id' 2>/dev/null || true

if [ "$COUNT" -lt 3 ]; then
    echo "FAIL: expected >= 3 phones, got $COUNT"
    exit 1
fi
echo "PASS: $COUNT phones registered (>= 3)"

for id in $EXPECTED_IDS; do
    if echo "$PHONES" | jq -e ".[] | select(.id == \"$id\")" > /dev/null 2>&1; then
        echo "PASS: $id present"
    else
        echo "FAIL: $id missing"
        exit 1
    fi
done

echo "=== Test 3 PASSED ==="
