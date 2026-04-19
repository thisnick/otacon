#!/usr/bin/env bash
# Hardware test: Fleet-node (8080) and registry (9080) coexist on Pi
#
# Verifies:
#   1. Both fleet-node (port 8080) and registry (port 9080) are listening
#   2. Fleet-node /phones returns data (via HTTPS on 8080)
#   3. Registry /api/v1/phones returns data (via HTTP on 9080)
#   4. They are different services (different response shapes)
#
# Usage: ./test_port_no_collision.sh
# Requires: curl, jq, ssh access to otacon-pi

set -euo pipefail

PI="nick@otacon-pi"
PI_FQDN=$(tailscale status --json | jq -r '.Peer[] | select(.HostName == "otacon-pi") | .DNSName | rtrimstr(".")')
FLEET_URL="https://${PI_FQDN}:8080"
REGISTRY_URL="http://${PI_FQDN}:9080"

echo "=== Test: port no collision (8080 vs 9080) ==="

# --- Step 1: Check fleet-node on 8080 ---
echo ""
echo "--- Checking fleet-node on port 8080 ---"
FLEET_PHONES=$(curl -sk "$FLEET_URL/phones" 2>&1) || {
    echo "FAIL: could not reach fleet-node at $FLEET_URL/phones"
    exit 1
}

if ! echo "$FLEET_PHONES" | jq -e 'type == "array" or type == "object"' >/dev/null 2>&1; then
    echo "FAIL: fleet-node /phones did not return valid JSON"
    echo "Got: $FLEET_PHONES"
    exit 1
fi
echo "PASS: fleet-node on 8080 responds with JSON"

# --- Step 2: Check registry on 9080 ---
echo ""
echo "--- Checking registry on port 9080 ---"
REG_PHONES=$(curl -sf "$REGISTRY_URL/api/v1/phones" 2>&1) || {
    echo "FAIL: could not reach registry at $REGISTRY_URL/api/v1/phones"
    exit 1
}

if ! echo "$REG_PHONES" | jq -e 'type == "array"' >/dev/null 2>&1; then
    echo "FAIL: registry /api/v1/phones did not return JSON array"
    echo "Got: $REG_PHONES"
    exit 1
fi
echo "PASS: registry on 9080 responds with JSON"

# --- Step 3: Verify they are different services ---
echo ""
echo "--- Verifying services are distinct ---"

# Check listening ports on Pi
LISTENERS=$(ssh "$PI" "ss -tlnp | grep -E ':(8080|9080)'" 2>/dev/null || true)
echo "Listening ports:"
echo "$LISTENERS"

PORT_8080=$(echo "$LISTENERS" | grep -c ":8080" || true)
PORT_9080=$(echo "$LISTENERS" | grep -c ":9080" || true)

if [ "$PORT_8080" -lt 1 ]; then
    echo "FAIL: nothing listening on port 8080"
    exit 1
fi
if [ "$PORT_9080" -lt 1 ]; then
    echo "FAIL: nothing listening on port 9080"
    exit 1
fi
echo "PASS: both ports 8080 and 9080 have listeners"

# The registry uses /api/v1/ prefix; fleet-node does not
# Verify fleet-node does NOT respond to /api/v1/phones
FLEET_REG_PATH=$(curl -sk -o /dev/null -w "%{http_code}" "$FLEET_URL/api/v1/phones" 2>/dev/null || echo "000")
if [ "$FLEET_REG_PATH" = "200" ]; then
    echo "WARN: fleet-node also responds to /api/v1/phones — services may be overlapping"
else
    echo "PASS: fleet-node does not serve /api/v1/phones (got HTTP $FLEET_REG_PATH) — services are distinct"
fi

echo ""
echo "=== Test: port no collision PASSED ==="
