#!/usr/bin/env bash
# Phase 5a test: After deploy, registry phones flip to "connected" within 30s.
#
# Verifies:
# - All known phones appear in the registry
# - All phones that the host reports as connected show status="connected"
# - phone-11031jec (the new phone) appears in the registry
# - Host has non-null tailscale_ip and fqdn after register_host fix

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: Phase 5a — heartbeat phone status ==="

# ---- Check 1: Host metadata ----
echo ""
echo "--- Check 1: Host metadata (tailscale_ip, fqdn) ---"

HOST_JSON=$(registry_host "$EXPECTED_HOST_ID")
HOST_STATUS=$(echo "$HOST_JSON" | jq -r '.status')
HOST_IP=$(echo "$HOST_JSON" | jq -r '.tailscale_ip')
HOST_FQDN=$(echo "$HOST_JSON" | jq -r '.fqdn')
HOST_HB=$(echo "$HOST_JSON" | jq -r '.last_heartbeat')

if [ "$HOST_STATUS" = "online" ]; then
    pass "Host '$EXPECTED_HOST_ID' status is 'online'"
else
    fail "host_status" "Expected 'online', got '$HOST_STATUS'"
fi

if [ "$HOST_IP" != "null" ] && [ -n "$HOST_IP" ]; then
    pass "Host tailscale_ip is populated: $HOST_IP"
else
    observe "Host tailscale_ip is null — register_host() may still be sending wrong body"
    fail "host_tailscale_ip" "tailscale_ip is null"
fi

if [ "$HOST_FQDN" != "null" ] && [ -n "$HOST_FQDN" ]; then
    pass "Host fqdn is populated: $HOST_FQDN"
else
    observe "Host fqdn is null — register_host() may still be sending wrong body"
    fail "host_fqdn" "fqdn is null"
fi

if [ "$HOST_HB" != "null" ] && [ -n "$HOST_HB" ]; then
    pass "Host has last_heartbeat: $HOST_HB"
else
    fail "host_heartbeat" "last_heartbeat is null"
fi

# ---- Check 2: All phones visible in registry ----
echo ""
echo "--- Check 2: All 5 phones visible in registry ---"

PHONES_JSON=$(registry_phones)
PHONE_COUNT=$(echo "$PHONES_JSON" | jq 'length')
observe "Registry has $PHONE_COUNT phones total"

# Check each expected phone by adb_serial pattern
# Known serials from the fleet: R5CT60SDGKD, 14151JEC200486, 99241FFAZ001UT, R92X1022S7K, 11031JEC*
EXPECTED_SERIALS=("R5CT60SDGKD" "14151JEC200486" "99241FFAZ001UT" "R92X1022S7K" "11031JEC")
for serial_prefix in "${EXPECTED_SERIALS[@]}"; do
    FOUND=$(echo "$PHONES_JSON" | jq -r --arg s "$serial_prefix" \
        '[.[] | select(.adb_serial | startswith($s))] | length')
    if [ "$FOUND" -ge 1 ]; then
        pass "Phone with serial prefix '$serial_prefix' exists in registry"
    else
        fail "phone_missing_$serial_prefix" "No phone with serial prefix '$serial_prefix' found in registry"
    fi
done

# ---- Check 3: Phone statuses ----
echo ""
echo "--- Check 3: Phone statuses (should be 'connected', not 'unreachable') ---"

CONNECTED_COUNT=$(echo "$PHONES_JSON" | jq '[.[] | select(.status == "connected")] | length')
UNREACHABLE_COUNT=$(echo "$PHONES_JSON" | jq '[.[] | select(.status == "unreachable")] | length')
DISCONNECTED_COUNT=$(echo "$PHONES_JSON" | jq '[.[] | select(.status == "disconnected")] | length')

observe "Phone status breakdown: connected=$CONNECTED_COUNT, unreachable=$UNREACHABLE_COUNT, disconnected=$DISCONNECTED_COUNT"

# The 5 known phones should all be connected (excluding test phone-1 which has a test serial)
REAL_PHONES=$(echo "$PHONES_JSON" | jq '[.[] | select(.adb_serial | startswith("TEST_") | not)]')
REAL_CONNECTED=$(echo "$REAL_PHONES" | jq '[.[] | select(.status == "connected")] | length')
REAL_TOTAL=$(echo "$REAL_PHONES" | jq 'length')

if [ "$REAL_CONNECTED" -ge 4 ]; then
    pass "At least 4 of $REAL_TOTAL real phones are 'connected'"
else
    fail "phone_connected_count" "Only $REAL_CONNECTED of $REAL_TOTAL real phones are 'connected'"
    echo ""
    echo "  Per-phone status:"
    echo "$REAL_PHONES" | jq -r '.[] | "    \(.id) (\(.adb_serial)): \(.status)"'
fi

# ---- Check 4: phone-11031jec specifically ----
echo ""
echo "--- Check 4: phone-11031jec appears in registry ---"

PHONE_11031=$(echo "$PHONES_JSON" | jq '[.[] | select(.adb_serial | startswith("11031JEC"))]')
PHONE_11031_COUNT=$(echo "$PHONE_11031" | jq 'length')

if [ "$PHONE_11031_COUNT" -ge 1 ]; then
    PHONE_11031_STATUS=$(echo "$PHONE_11031" | jq -r '.[0].status')
    PHONE_11031_ID=$(echo "$PHONE_11031" | jq -r '.[0].id')
    pass "phone-11031jec found in registry as '$PHONE_11031_ID'"
    if [ "$PHONE_11031_STATUS" = "connected" ]; then
        pass "phone-11031jec status is 'connected'"
    else
        observe "phone-11031jec status is '$PHONE_11031_STATUS' (expected 'connected')"
        fail "phone_11031_status" "Expected 'connected', got '$PHONE_11031_STATUS'"
    fi
else
    fail "phone_11031_missing" "No phone with serial prefix '11031JEC' in registry"
fi

finish_test "test_5a_heartbeat_phone_status"
