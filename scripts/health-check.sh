#!/bin/bash
# Health check: verify all services are running.
set -euo pipefail

OK=0
FAIL=0

check() {
    local name="$1"
    local cmd="$2"
    if eval "${cmd}" &>/dev/null; then
        echo "  [OK] ${name}"
        OK=$((OK + 1))
    else
        echo "  [FAIL] ${name}"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== Otacon Health Check ==="

echo "Services:"
check "Docker" "docker info"
check "phone-mirror container" "docker compose ps --status running | grep -q phone-mirror"
check "gnirehtet container" "docker compose ps --status running | grep -q gnirehtet"

echo "Connectivity:"
check "ADB device" "adb devices | grep -q 'device$'"
check "VNC port (${VNC_PORT:-5900})" "nc -z localhost ${VNC_PORT:-5900}"

echo ""
echo "Results: ${OK} OK, ${FAIL} FAIL"
[ "${FAIL}" -eq 0 ] && exit 0 || exit 1
