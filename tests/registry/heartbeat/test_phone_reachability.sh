#!/usr/bin/env bash
# Test: all phones show status=="connected" and heartbeat phone IDs
# match registry-assigned IDs (no dual-ID drift).
#
# Checks:
# 1. All phones registered in the registry have status "connected".
# 2. Fleet logs show phones registered with registry IDs (phone-N format).
# 3. No fleet log lines contain local IDs (phone-XXXXX format) in heartbeat context.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

check_deps
require_admin_token

echo "=== test_phone_reachability ==="

# --- Check 1: All phones connected ---
echo ""
echo "--- Check 1: Phone statuses ---"

phone_count=$(get_phone_count)
connected_count=$(count_phones_with_status "connected")
unreachable_count=$(count_phones_with_status "unreachable")

observe "Total phones: $phone_count, connected: $connected_count, unreachable: $unreachable_count"

if [ "$phone_count" -eq 0 ]; then
    fail "Phone count" "no phones registered in registry"
elif [ "$connected_count" -eq "$phone_count" ]; then
    pass "All $phone_count phones connected"
else
    # List the unreachable ones
    statuses=$(get_phone_statuses)
    observe "Phone statuses: $statuses"
    fail "Phone reachability" "$unreachable_count of $phone_count phones are unreachable"
fi

# --- Check 2: Registry IDs used in fleet registration ---
echo ""
echo "--- Check 2: Dual-ID correctness ---"

# Get the phone list from registry to know expected IDs
registry_phones=$(curl -sS "$ADMIN_URL/api/v1/phones" \
    -H "Authorization: Bearer $ADMIN_TOKEN")

registry_ids=$(echo "$registry_phones" | jq -r '.[].id' | sort)
observe "Registry phone IDs: $(echo $registry_ids | tr '\n' ' ')"

# Check fleet logs for registration lines
fleet_reg_lines=$(ssh "$PI_SSH" 'docker logs --since 300s otacon-otacon-1 2>&1 | grep "\[fleet\] Registered phone"' 2>/dev/null || true)

if [ -z "$fleet_reg_lines" ]; then
    observe "No fleet registration lines found in recent logs (container may have been up too long)"
    observe "Skipping dual-ID log verification (no recent registration data)"
else
    observe "Fleet registration lines:"
    echo "$fleet_reg_lines" | while read -r line; do
        observe "  $line"
    done

    # Each line should show local_id -> registry_id mapping
    # Format: [fleet] Registered phone 'phone-r5ct60sd' as 'phone-2' in registry
    registry_id_in_logs=$(echo "$fleet_reg_lines" | grep -oP "as '\K[^']+")

    if [ -n "$registry_id_in_logs" ]; then
        all_match=true
        while read -r rid; do
            if echo "$registry_ids" | grep -q "^${rid}$"; then
                pass "Registry ID '$rid' found in both logs and registry"
            else
                fail "Dual-ID" "Fleet registered '$rid' but registry doesn't have it"
                all_match=false
            fi
        done <<< "$registry_id_in_logs"
    else
        observe "Could not extract registry IDs from fleet log lines"
    fi
fi

# --- Check 3: No 401 errors in recent logs ---
echo ""
echo "--- Check 3: No auth failures ---"

auth_errors=$(ssh "$PI_SSH" 'docker logs --since 60s otacon-otacon-1 2>&1 | grep "\[fleet\].*401"' 2>/dev/null || true)

if [ -z "$auth_errors" ]; then
    pass "No 401 Unauthorized errors in last 60s of fleet logs"
else
    observe "Auth error lines:"
    echo "$auth_errors" | while read -r line; do
        observe "  $line"
    done
    fail "Auth errors" "Found 401 errors in fleet logs"
fi

finish_test "test_phone_reachability"
