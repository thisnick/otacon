#!/usr/bin/env bash
# Test: container restart survival — heartbeat resumes within 90s
# after force-recreate, without human intervention.
#
# Steps:
# 1. Force-recreate the otacon container.
# 2. Wait up to 90s for heartbeat to advance.
# 3. Verify all phones come back to "connected".
# 4. Verify auth.json persists across restart (token survives).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

check_deps
require_admin_token

echo "=== test_restart_survival ==="

# Snapshot heartbeat before restart
pre_ts=$(get_heartbeat_ts)
observe "Pre-restart heartbeat: $pre_ts"

# Force-recreate container
echo ""
echo "--- Recreating otacon container ---"
ssh "$PI_SSH" 'docker compose -f /home/nick/otacon/docker-compose.yml up -d --force-recreate otacon' 2>&1
observe "Container recreated"

# Verify auth.json persists
echo ""
echo "--- Check: auth.json persistence ---"
sleep 5  # wait for container to start
auth_json=$(ssh "$PI_SSH" 'docker exec otacon-otacon-1 cat /data/otacon/auth.json 2>/dev/null' || true)
if [ -z "$auth_json" ]; then
    fail "Token persistence" "auth.json not found after restart"
else
    has_token=$(echo "$auth_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d.get('token') else 'no')" 2>/dev/null || echo "no")
    if [ "$has_token" = "yes" ]; then
        pass "auth.json persists with token after restart"
    else
        fail "Token persistence" "auth.json exists but has no token"
    fi
fi

# Wait for heartbeat to advance (up to 90s)
echo ""
echo "--- Waiting for heartbeat to advance (max 90s) ---"
deadline=$(($(date +%s) + 90))
heartbeat_advanced=false
check_num=0

while [ "$(date +%s)" -lt "$deadline" ]; do
    check_num=$((check_num + 1))
    current_ts=$(get_heartbeat_ts)

    if [ "$current_ts" != "$pre_ts" ] && [ "$current_ts" != "null" ]; then
        observe "Check $check_num: heartbeat advanced to $current_ts"
        heartbeat_advanced=true
        break
    fi

    observe "Check $check_num: still $current_ts (waiting...)"
    sleep 10
done

if [ "$heartbeat_advanced" = "true" ]; then
    pass "Heartbeat advanced within 90s of restart"
else
    fail "Heartbeat resume" "heartbeat did not advance within 90s (stuck at $pre_ts)"
fi

# Verify freshness
echo ""
echo "--- Check: heartbeat freshness ---"
final_ts=$(get_heartbeat_ts)
if [ "$final_ts" != "null" ] && [ -n "$final_ts" ]; then
    final_epoch=$(ts_to_epoch "$final_ts")
    now_epoch=$(date -u +%s)
    age=$((now_epoch - final_epoch))
    if [ "$age" -le 60 ]; then
        pass "Heartbeat age ${age}s (within 60s)"
    else
        fail "Heartbeat freshness" "heartbeat is ${age}s old after restart"
    fi
else
    fail "Heartbeat freshness" "heartbeat timestamp is null after restart"
fi

# Verify all phones connected
echo ""
echo "--- Check: all phones connected after restart ---"
# Give a bit more time for phones to reconnect
sleep 10
phone_count=$(get_phone_count)
connected_count=$(count_phones_with_status "connected")

if [ "$phone_count" -gt 0 ] && [ "$connected_count" -eq "$phone_count" ]; then
    pass "All $phone_count phones connected after restart"
else
    unreachable=$(count_phones_with_status "unreachable")
    statuses=$(get_phone_statuses)
    observe "Phone statuses: $statuses"
    fail "Phone recovery" "$unreachable of $phone_count phones unreachable after restart"
fi

# Verify no 401 errors
echo ""
echo "--- Check: no auth failures after restart ---"
auth_errors=$(ssh "$PI_SSH" 'docker logs --since 60s otacon-otacon-1 2>&1 | grep "\[fleet\].*401"' 2>/dev/null || true)
if [ -z "$auth_errors" ]; then
    pass "No 401 errors in fleet logs after restart"
else
    fail "Post-restart auth" "401 errors found in fleet logs after restart"
fi

finish_test "test_restart_survival"
