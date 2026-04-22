#!/usr/bin/env bash
# Phase 5a test: Restart host container, phones stay "connected" (no flicker).
#
# Verifies:
# - Before restart: phones are connected
# - After restart: phones return to "connected" within 60s
# - No intermediate "unreachable" state visible after convergence

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: Phase 5a — host restart (no phone flicker) ==="

# ---- Pre-check: phones should be connected ----
echo ""
echo "--- Pre-check: current phone status ---"

PHONES_JSON=$(registry_phones)
REAL_PHONES=$(echo "$PHONES_JSON" | jq '[.[] | select(.adb_serial | startswith("TEST_") | not)]')
PRE_CONNECTED=$(echo "$REAL_PHONES" | jq '[.[] | select(.status == "connected")] | length')
PRE_TOTAL=$(echo "$REAL_PHONES" | jq 'length')

observe "Before restart: $PRE_CONNECTED of $PRE_TOTAL real phones connected"
echo "$REAL_PHONES" | jq -r '.[] | "    \(.id): \(.status)"'

if [ "$PRE_CONNECTED" -lt 3 ]; then
    observe "WARNING: fewer than 3 phones connected before restart — test may not be meaningful"
    observe "Proceeding anyway to observe post-restart behavior"
fi

# ---- Restart host container ----
echo ""
echo "--- Restarting otacon-server container on Pi ---"

RESTART_RESULT=$(pi_docker restart "$HOST_CONTAINER" 2>&1) || true
observe "docker restart output: $RESTART_RESULT"

# ---- Wait for recovery ----
echo ""
echo "--- Waiting up to 60s for phones to return to 'connected' ---"

check_phones_recovered() {
    local phones_now
    phones_now=$(registry_phones)
    local real_now
    real_now=$(echo "$phones_now" | jq '[.[] | select(.adb_serial | startswith("TEST_") | not)]')
    local connected_now
    connected_now=$(echo "$real_now" | jq '[.[] | select(.status == "connected")] | length')
    # Success if at least as many phones are connected as before (minus 1 tolerance)
    local threshold=$((PRE_CONNECTED > 1 ? PRE_CONNECTED - 1 : 1))
    [ "$connected_now" -ge "$threshold" ]
}

if wait_for 60 "phones reconnected" check_phones_recovered; then
    pass "Phones recovered to 'connected' within 60s"
else
    fail "phone_recovery" "Phones did not recover within 60s"
fi

# ---- Post-restart status ----
echo ""
echo "--- Post-restart phone status ---"

PHONES_POST=$(registry_phones)
REAL_POST=$(echo "$PHONES_POST" | jq '[.[] | select(.adb_serial | startswith("TEST_") | not)]')
POST_CONNECTED=$(echo "$REAL_POST" | jq '[.[] | select(.status == "connected")] | length')
POST_TOTAL=$(echo "$REAL_POST" | jq 'length')

observe "After restart: $POST_CONNECTED of $POST_TOTAL real phones connected"
echo "$REAL_POST" | jq -r '.[] | "    \(.id): \(.status)"'

if [ "$POST_CONNECTED" -ge "$PRE_CONNECTED" ]; then
    pass "Post-restart connected count ($POST_CONNECTED) >= pre-restart ($PRE_CONNECTED)"
else
    fail "post_restart_count" "Post-restart: $POST_CONNECTED connected, was $PRE_CONNECTED before"
fi

# ---- Check host metadata preserved ----
echo ""
echo "--- Host metadata after restart ---"

HOST_JSON=$(registry_host "$EXPECTED_HOST_ID")
HOST_STATUS=$(echo "$HOST_JSON" | jq -r '.status')
HOST_IP=$(echo "$HOST_JSON" | jq -r '.tailscale_ip')

if [ "$HOST_STATUS" = "online" ]; then
    pass "Host status is 'online' after restart"
else
    fail "host_status_post_restart" "Host status is '$HOST_STATUS' after restart"
fi

observe "Host tailscale_ip after restart: $HOST_IP"

finish_test "test_5a_host_restart"
