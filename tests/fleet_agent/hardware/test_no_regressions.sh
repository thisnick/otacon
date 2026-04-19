#!/usr/bin/env bash
# Hardware test 10: No regressions on the 3 phones
#
# Usage: ./test_no_regressions.sh
# Requires: curl, jq, access to otacon-pi:8080

set -euo pipefail

PI_URL="https://otacon-pi:8080"
PHONES="phone-14151jec phone-r92x1022 phone-r5ct60sd"

echo "=== Test 10: No regressions ==="

for phone in $PHONES; do
    echo "--- $phone ---"

    # Screenshot returns 200 + non-empty PNG
    HTTP_CODE=$(curl -sk -o /tmp/test_screenshot.png -w '%{http_code}' \
        "$PI_URL/phones/$phone/api/screenshot" 2>/dev/null)
    SIZE=$(stat -f%z /tmp/test_screenshot.png 2>/dev/null || stat -c%s /tmp/test_screenshot.png 2>/dev/null || echo 0)

    if [ "$HTTP_CODE" = "200" ] && [ "$SIZE" -gt 100 ]; then
        echo "  screenshot: PASS (HTTP $HTTP_CODE, ${SIZE} bytes)"
    else
        echo "  screenshot: FAIL (HTTP $HTTP_CODE, ${SIZE} bytes)"
        exit 1
    fi

    # Bridge is true
    BRIDGE=$(curl -sk "$PI_URL/phones/$phone/api/info" | jq -r '.bridge // false')
    if [ "$BRIDGE" = "true" ]; then
        echo "  bridge: PASS"
    else
        echo "  bridge: FAIL (bridge=$BRIDGE)"
        exit 1
    fi

    # WiFi check via monitor status
    WIFI=$(curl -sk "$PI_URL/phones/$phone/api/info" | jq -r '.monitor.health.wifi // "unknown"')
    echo "  wifi: $WIFI"
done

rm -f /tmp/test_screenshot.png
echo "=== Test 10 PASSED ==="
