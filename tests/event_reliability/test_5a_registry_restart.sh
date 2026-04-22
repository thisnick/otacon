#!/usr/bin/env bash
# Phase 5a test: Restart registry, host re-registers cleanly, phones reconnect.
#
# Verifies:
# - Registry restarts successfully
# - Host re-registers and appears "online" within 60s
# - Phones return to "connected" status within 60s after registry comes back

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: Phase 5a — registry restart ==="

# ---- Pre-check ----
echo ""
echo "--- Pre-check: current state ---"

PHONES_JSON=$(registry_phones)
REAL_PHONES=$(echo "$PHONES_JSON" | jq '[.[] | select(.adb_serial | startswith("TEST_") | not)]')
PRE_CONNECTED=$(echo "$REAL_PHONES" | jq '[.[] | select(.status == "connected")] | length')
observe "Pre-restart: $PRE_CONNECTED real phones connected"

# ---- Restart registry ----
echo ""
echo "--- Restarting registry container ---"

# The registry runs on the same Pi (or wherever REGISTRY_URL points).
# We need SSH access to the machine running the registry.
# For now, assume it's accessible via Pi SSH (co-located).
RESTART_RESULT=$(pi_docker restart "$REGISTRY_CONTAINER" 2>&1) || true
observe "docker restart output: $RESTART_RESULT"

# ---- Wait for registry to come back ----
echo ""
echo "--- Waiting up to 30s for registry to respond ---"

check_registry_up() {
    local result
    result=$(http_get "$REGISTRY_URL/api/v1/admin/hosts" "$ADMIN_TOKEN")
    local status
    status=$(get_status "$result")
    [ "$status" = "200" ]
}

if wait_for 30 "registry responding" check_registry_up; then
    pass "Registry responded to API call within 30s"
else
    fail "registry_up" "Registry did not respond within 30s"
    finish_test "test_5a_registry_restart"
fi

# ---- Wait for host to re-register ----
echo ""
echo "--- Waiting up to 60s for host to re-register ---"

check_host_online() {
    local host_json
    host_json=$(registry_host "$EXPECTED_HOST_ID")
    local status
    status=$(echo "$host_json" | jq -r '.status')
    [ "$status" = "online" ]
}

if wait_for 60 "host online" check_host_online; then
    pass "Host '$EXPECTED_HOST_ID' re-registered as 'online'"
else
    fail "host_reregister" "Host did not return to 'online' within 60s"
fi

# ---- Wait for phones to reconnect ----
echo ""
echo "--- Waiting up to 60s for phones to return to 'connected' ---"

check_phones_connected() {
    local phones_now
    phones_now=$(registry_phones)
    local real_now
    real_now=$(echo "$phones_now" | jq '[.[] | select(.adb_serial | startswith("TEST_") | not)]')
    local connected_now
    connected_now=$(echo "$real_now" | jq '[.[] | select(.status == "connected")] | length')
    local threshold=$((PRE_CONNECTED > 1 ? PRE_CONNECTED - 1 : 1))
    [ "$connected_now" -ge "$threshold" ]
}

if wait_for 60 "phones reconnected" check_phones_connected; then
    pass "Phones reconnected after registry restart"
else
    fail "phone_reconnect" "Phones did not reconnect within 60s"
fi

# ---- Final status ----
echo ""
echo "--- Post-restart status ---"

PHONES_POST=$(registry_phones)
REAL_POST=$(echo "$PHONES_POST" | jq '[.[] | select(.adb_serial | startswith("TEST_") | not)]')
POST_CONNECTED=$(echo "$REAL_POST" | jq '[.[] | select(.status == "connected")] | length')
POST_TOTAL=$(echo "$REAL_POST" | jq 'length')

observe "After registry restart: $POST_CONNECTED of $POST_TOTAL real phones connected"
echo "$REAL_POST" | jq -r '.[] | "    \(.id): \(.status)"'

finish_test "test_5a_registry_restart"
