#!/usr/bin/env bash
# Test: Verify only registry has its own Tailscale identity
# - `otacon-registry` appears as a separate tailnet node
# - `otacon-admin` does NOT appear (no sidecar — rides on host network)

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps

echo "=== Test: only registry on Tailscale (admin uses host network) ==="

# Get tailscale status
TS_STATUS=$(tailscale status --json 2>/dev/null)
if [ -z "$TS_STATUS" ]; then
    fail "tailscale" "Cannot get tailscale status"
    finish_test "test_only_registry_on_tailnet"
fi

# Check for otacon-registry node — SHOULD exist
echo ""
echo "--- Checking for otacon-registry ---"
REGISTRY_NODE=$(echo "$TS_STATUS" | jq -r '.Peer[] | select(.HostName == "otacon-registry") | .DNSName' 2>/dev/null)
if [ -n "$REGISTRY_NODE" ]; then
    pass "otacon-registry found on tailnet: $REGISTRY_NODE"
else
    fail "registry_node" "otacon-registry not found in tailscale status"
fi

# Check tags if available
REGISTRY_TAGS=$(echo "$TS_STATUS" | jq -r '.Peer[] | select(.HostName == "otacon-registry") | .Tags // [] | join(", ")' 2>/dev/null)
if [ -n "$REGISTRY_TAGS" ]; then
    echo "  Registry tags: $REGISTRY_TAGS"
    if echo "$REGISTRY_TAGS" | grep -q "registry"; then
        pass "Registry has registry tag"
    else
        observe "Registry tags don't include 'registry': $REGISTRY_TAGS"
    fi
else
    observe "No tags visible for otacon-registry (may require ACL admin access)"
fi

# Check for otacon-admin node — SHOULD NOT exist
echo ""
echo "--- Checking that otacon-admin is NOT on tailnet ---"
ADMIN_NODE=$(echo "$TS_STATUS" | jq -r '.Peer[] | select(.HostName == "otacon-admin") | .DNSName' 2>/dev/null)
if [ -z "$ADMIN_NODE" ]; then
    pass "otacon-admin correctly absent from tailnet (uses host network)"
else
    fail "admin_on_tailnet" "otacon-admin found on tailnet: $ADMIN_NODE — should NOT have its own identity"
fi

# Verify admin is reachable via the Pi's host port 9090
echo ""
echo "--- Checking admin reachable on host port 9090 ---"
RESULT=$(http_get "$ADMIN_URL/" 2>/dev/null || true)
STATUS=$(get_status "$RESULT")
if [ "$STATUS" = "200" ]; then
    pass "Admin reachable at $ADMIN_URL (host port 9090)"
else
    observe "Admin returned $STATUS at $ADMIN_URL (may need auth or startup time)"
fi

finish_test "test_only_registry_on_tailnet"
