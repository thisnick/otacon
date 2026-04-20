#!/usr/bin/env bash
# Test: heartbeat liveness — last_heartbeat advances every ~30s.
#
# Takes 5 samples with 35s gaps. Each sample's timestamp must differ from
# the previous, and the final timestamp must be within 60s of current UTC.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

check_deps
require_admin_token

echo "=== test_heartbeat_liveness ==="
echo "Taking 5 heartbeat samples with 35s gaps..."

CYCLES=5
SLEEP_SECS=35
prev_ts=""

for i in $(seq 1 $CYCLES); do
    ts=$(get_heartbeat_ts)
    now_utc=$(date -u +%Y-%m-%dT%H:%M:%S)

    observe "Sample $i/$CYCLES: last_heartbeat=$ts (now=$now_utc)"

    if [ "$ts" = "null" ] || [ -z "$ts" ]; then
        fail "Sample $i" "last_heartbeat is null"
    elif [ -n "$prev_ts" ] && [ "$ts" = "$prev_ts" ]; then
        fail "Sample $i" "timestamp did not advance (stuck at $ts)"
    else
        pass "Sample $i: timestamp=$ts"
    fi

    prev_ts="$ts"

    if [ "$i" -lt "$CYCLES" ]; then
        echo "    Sleeping ${SLEEP_SECS}s..."
        sleep "$SLEEP_SECS"
    fi
done

# Final check: last_heartbeat within 60s of current UTC
final_ts=$(get_heartbeat_ts)
if [ "$final_ts" = "null" ] || [ -z "$final_ts" ]; then
    fail "Freshness" "last_heartbeat is null"
else
    final_epoch=$(ts_to_epoch "$final_ts")
    now_epoch=$(date -u +%s)
    age=$((now_epoch - final_epoch))
    observe "Final heartbeat age: ${age}s"
    if [ "$age" -gt 60 ]; then
        fail "Freshness" "last_heartbeat is ${age}s old (>60s stale)"
    else
        pass "Freshness: last_heartbeat is ${age}s old (within 60s)"
    fi
fi

finish_test "test_heartbeat_liveness"
