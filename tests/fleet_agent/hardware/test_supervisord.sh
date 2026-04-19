#!/usr/bin/env bash
# Hardware test 1+2: Supervisord program list and uptime
# Verifies fleet-agent is RUNNING, old programs are absent, uptime >= 60s
#
# Usage: ./test_supervisord.sh
# Requires: SSH access to otacon-pi

set -euo pipefail

PI="nick@otacon-pi"
CONTAINER="otacon-otacon-1"

echo "=== Test 1+2: Supervisord program list + uptime ==="

STATUS=$(ssh "$PI" "docker exec $CONTAINER supervisorctl status" 2>/dev/null)
echo "$STATUS"

# Check fleet-agent is RUNNING
if echo "$STATUS" | grep -q '^fleet-agent.*RUNNING'; then
    echo "PASS: fleet-agent is RUNNING"
else
    echo "FAIL: fleet-agent is not RUNNING"
    exit 1
fi

# Check old programs are absent
for old in device-monitor bluetooth-agent bt-reconnect; do
    if echo "$STATUS" | grep -q "^${old}"; then
        echo "FAIL: old program '$old' still present in supervisord"
        exit 1
    fi
done
echo "PASS: old programs (device-monitor, bluetooth-agent, bt-reconnect) absent"

# Check uptime >= 60s
UPTIME_STR=$(echo "$STATUS" | grep '^fleet-agent' | grep -o 'uptime [0-9:]*' || true)
if [ -z "$UPTIME_STR" ]; then
    echo "FAIL: could not parse fleet-agent uptime"
    exit 1
fi

# Parse uptime — format is "uptime H:MM:SS" or "uptime D days, H:MM:SS"
SECONDS_UP=0
if echo "$UPTIME_STR" | grep -q 'days'; then
    DAYS=$(echo "$UPTIME_STR" | grep -o '[0-9]* days' | cut -d' ' -f1)
    SECONDS_UP=$((DAYS * 86400))
fi
TIME_PART=$(echo "$UPTIME_STR" | grep -oE '[0-9]+:[0-9]+:[0-9]+' || echo "0:0:0")
IFS=: read -r h m s <<< "$TIME_PART"
SECONDS_UP=$((SECONDS_UP + 10#$h * 3600 + 10#$m * 60 + 10#$s))

if [ "$SECONDS_UP" -ge 60 ]; then
    echo "PASS: fleet-agent uptime ${SECONDS_UP}s >= 60s"
else
    echo "FAIL: fleet-agent uptime ${SECONDS_UP}s < 60s"
    exit 1
fi

echo "=== Tests 1+2 PASSED ==="
