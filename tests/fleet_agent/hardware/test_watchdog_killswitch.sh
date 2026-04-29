#!/usr/bin/env bash
# Hardware test: kiosk watchdog kill switch.
#
# Verifies that flipping the watchdog_enabled SharedPreferences flag (via the
# KioskProvider ContentProvider) suppresses the reboot path. We do the same
# USB-cutoff that test_watchdog_usb_cutoff.sh does — but with the kill switch
# OFF, the phone should NOT reboot.
#
# Why this test exists:
#   The kill switch is the escape hatch for evaluators / debuggers who want
#   to keep a phone running while the host is unreachable. If it doesn't
#   work, the phase is unsafe to debug.
#
# Cleanup contract (CRITICAL):
#   - Always re-enable the watchdog flag on exit. Leaving it off would
#     silently disable self-healing on a fleet phone.
#   - Always re-bind USB device on exit.
#
# Canary phone: same default as test_watchdog_usb_cutoff.sh.
#
# WARNING: This test takes ~5 minutes. Phone must NOT reboot for test to pass.
#
# Usage: ./test_watchdog_killswitch.sh
# Env: WATCHDOG_CANARY_SERIAL (default: 99241FFAZ001UT)

set -euo pipefail

PI="nick@otacon-pi"
CONTAINER="otacon-otacon-1"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
source "$REPO_ROOT/scripts/lib/tailscale.sh"

CANARY="${WATCHDOG_CANARY_SERIAL:-99241FFAZ001UT}"
WAIT_FOR_NO_REBOOT=240   # same window as the cutoff test

echo "=== Test: kiosk watchdog kill switch ==="
echo "canary serial: $CANARY"

# --- Resolve canary's USB device path ---
echo ""
echo "--- Resolving USB path for $CANARY ---"
USB_DEV=$(ssh "$PI" "docker exec $CONTAINER bash -c '
    for d in /sys/bus/usb/devices/*; do
        if [ -f \"\$d/serial\" ]; then
            sn=\$(cat \"\$d/serial\" 2>/dev/null || true)
            if [ \"\$sn\" = \"$CANARY\" ]; then
                basename \"\$d\"
                exit 0
            fi
        fi
    done
    exit 1
'" 2>/dev/null) || true

if [ -z "${USB_DEV:-}" ]; then
    echo "SKIP: cannot resolve USB device path for serial $CANARY"
    exit 0
fi
echo "USB device: $USB_DEV"

# --- Cleanup trap: ensure flag is re-enabled and USB rebound ---
cleanup() {
    local rc=$?
    echo ""
    echo "--- Cleanup: re-enable watchdog flag and rebind USB ---"
    # Rebind USB first so ADB is reachable for the subsequent flag flip.
    ssh "$PI" "docker exec $CONTAINER bash -c '
        if [ ! -L /sys/bus/usb/drivers/usb/$USB_DEV ]; then
            echo $USB_DEV > /sys/bus/usb/drivers/usb/bind 2>/dev/null || true
        fi
    '" 2>/dev/null || true

    # Wait for ADB so the next command lands.
    for i in 1 2 3 4 5 6 7 8 9 10; do
        if ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell true" 2>/dev/null; then
            break
        fi
        sleep 5
    done

    ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell content update \
        --uri content://com.otacon.kiosk/watchdog --bind enabled:i:1" 2>/dev/null || true
    return "$rc"
}
trap cleanup EXIT

# --- Pre-flight: ADB visibility ---
echo ""
echo "--- Pre-flight: ADB visibility ---"
if ! ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell true" 2>/dev/null; then
    echo "SKIP: $CANARY not reachable via ADB"
    exit 0
fi

# --- Baseline uptime ---
INITIAL_UPTIME=$(ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell cat /proc/uptime" 2>/dev/null | awk '{print $1}')
INITIAL_UPTIME_INT=${INITIAL_UPTIME%.*}
echo "initial uptime: ${INITIAL_UPTIME}s"

if [ "${INITIAL_UPTIME_INT:-0}" -lt 360 ]; then
    echo "SKIP: phone uptime ${INITIAL_UPTIME_INT}s < 6min — boot grace would mask the kill switch"
    exit 0
fi

# --- Disable watchdog via ContentProvider ---
echo ""
echo "--- Disabling watchdog via content://com.otacon.kiosk/watchdog ---"
DISABLE_OUT=$(ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell content update \
    --uri content://com.otacon.kiosk/watchdog --bind enabled:i:0" 2>/dev/null || true)
echo "disable response: ${DISABLE_OUT:-<no output>}"

# Verify it stuck.
QUERY_OUT=$(ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell content query \
    --uri content://com.otacon.kiosk/watchdog" 2>/dev/null || true)
echo "current flag: $QUERY_OUT"
if ! echo "$QUERY_OUT" | grep -qi 'enabled=0\|enabled=false'; then
    echo "WARN: kill switch flag not visible as 0 in query output (may still be effective)"
fi

# --- Cut USB ---
echo ""
echo "--- Cutting USB (unbind $USB_DEV) ---"
ssh "$PI" "docker exec $CONTAINER bash -c 'echo $USB_DEV > /sys/bus/usb/drivers/usb/unbind 2>&1 || true'" 2>/dev/null || true

# --- Hold USB offline through the full failure window ---
echo ""
echo "--- Holding USB offline ${WAIT_FOR_NO_REBOOT}s to provoke watchdog ---"
ELAPSED=0
while [ "$ELAPSED" -lt "$WAIT_FOR_NO_REBOOT" ]; do
    if [ $((ELAPSED % 60)) -eq 0 ]; then
        echo "  [${ELAPSED}s / ${WAIT_FOR_NO_REBOOT}s] still offline..."
    fi
    sleep 10
    ELAPSED=$((ELAPSED + 10))
done

# --- Restore USB ---
echo ""
echo "--- Restoring USB (bind $USB_DEV) ---"
# Bind may fail with "Resource busy" if fleet-agent's USB topology reset
# already rebound the device. Tolerate that — the trap cleanup also rebinds.
ssh "$PI" "docker exec $CONTAINER bash -c 'echo $USB_DEV > /sys/bus/usb/drivers/usb/bind 2>&1 || true'" 2>/dev/null || true

# --- Wait briefly for ADB ---
echo ""
echo "--- Waiting for ADB to come back ---"
ADB_BACK=false
ELAPSED=0
while [ "$ELAPSED" -lt 60 ]; do
    if ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell true" 2>/dev/null; then
        ADB_BACK=true
        echo "  ADB back at T+${ELAPSED}s"
        break
    fi
    sleep 5
    ELAPSED=$((ELAPSED + 5))
done

if [ "$ADB_BACK" != "true" ]; then
    echo "FAIL: ADB did not return after USB rebind"
    exit 1
fi

# --- The critical assertion: phone must NOT have rebooted ---
echo ""
echo "--- Verifying phone did NOT reboot ---"
NEW_UPTIME=$(ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell cat /proc/uptime" 2>/dev/null | awk '{print $1}')
NEW_UPTIME_INT=${NEW_UPTIME%.*}
echo "post-test uptime: ${NEW_UPTIME}s (initial: ${INITIAL_UPTIME}s)"

# Uptime should have advanced by at least 240s since baseline (the wait
# period). If it instead snapped back to <120s, the watchdog rebooted —
# kill switch is broken.
EXPECTED_MIN=$(( INITIAL_UPTIME_INT + WAIT_FOR_NO_REBOOT - 30 ))
if [ "${NEW_UPTIME_INT:-0}" -lt "$EXPECTED_MIN" ]; then
    echo "FAIL: uptime regressed (${NEW_UPTIME_INT}s < ${EXPECTED_MIN}s expected) — phone rebooted with kill switch ON"
    exit 1
fi
echo "PASS: uptime continuous through kill-switch window — no reboot occurred"

# --- Confirm no "TRIGGERING REBOOT" message in logcat during the window ---
# Release-mode APK isn't run-as-able, so we use logcat (Watchdog:I tag) which
# WatchdogReceiver writes before calling dpm.reboot(). If the kill switch
# worked, no such line should appear.
TRIGGER_LINE=$(ssh "$PI" "docker exec $CONTAINER adb -s $CANARY logcat -d -s Watchdog:I 2>/dev/null \
    | grep 'TRIGGERING REBOOT'" 2>/dev/null || true)
if [ -n "$TRIGGER_LINE" ]; then
    echo "FAIL: WatchdogReceiver emitted TRIGGERING REBOOT despite kill switch off"
    echo "  $TRIGGER_LINE"
    exit 1
fi
echo "PASS: no TRIGGERING REBOOT line in logcat — kill switch held"

echo ""
echo "=== Test: kiosk watchdog kill switch PASSED ==="
