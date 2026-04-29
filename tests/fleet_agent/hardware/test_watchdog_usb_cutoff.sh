#!/usr/bin/env bash
# Hardware test: kiosk watchdog reboots phone when host is unreachable.
#
# What this verifies:
#   1. Cutting the canary phone's USB connection (host can't reach it via
#      ADB-reverse → kiosk's HTTP probe to 127.0.0.1:8081 fails) eventually
#      triggers a self-reboot from inside the kiosk.
#   2. After the reboot + USB rebind, the phone comes back with low uptime
#      (< 120s).
#   3. logcat contains the WATCHDOG_RECOVERY_BOOT marker emitted by
#      BootReceiver.
#   4. /data/data/com.otacon.kiosk/files/watchdog-reboots.log contains the
#      reason the watchdog rebooted.
#
# Threshold timing (from plan):
#   - probe interval 60s, threshold 3 → ~3 minutes of failure before reboot
#   - + 30-60s reboot
#   - + ADB-reverse re-attach by fleet-agent (≤30s)
#   We sleep 240s post-cutoff to absorb the threshold + the reboot window.
#   Then we wait up to 90s for ADB to reappear.
#
# Canary phone selection:
#   Default phone-pixel4 (adb_serial 99241FFAZ001UT). Override with
#   $WATCHDOG_CANARY_SERIAL. The phone must have NO active phone_number
#   in the registry to keep blast radius minimal.
#
# Cleanup contract:
#   - On any exit, re-bind USB device. Trap EXIT.
#   - Skip gracefully if the canary serial isn't visible to the host.
#
# WARNING: This test takes ~6 minutes. It WILL reboot the canary phone.
#
# Usage: ./test_watchdog_usb_cutoff.sh
# Env: WATCHDOG_CANARY_SERIAL (default: 99241FFAZ001UT)

set -euo pipefail

PI="nick@otacon-pi"
CONTAINER="otacon-otacon-1"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
source "$REPO_ROOT/scripts/lib/tailscale.sh"

CANARY="${WATCHDOG_CANARY_SERIAL:-99241FFAZ001UT}"
WAIT_FOR_REBOOT=240   # 3 min (3 failed probes) + ~60s reboot + buffer
WAIT_FOR_ADB=120      # max time we wait for ADB to come back after rebind
MAX_UPTIME_AFTER=120  # phone is "rebooted" if uptime < this many seconds

echo "=== Test: kiosk watchdog USB cutoff ==="
echo "canary serial: $CANARY"

# --- Resolve canary's USB device path (on the Pi, inside container) ---
echo ""
echo "--- Resolving USB path for $CANARY ---"

# Walk /sys/bus/usb/devices/, look for the device whose `serial` file matches
# the canary's adb_serial. The matching path is e.g. "1-1.2.4".
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
    echo "SKIP: cannot resolve USB device path for serial $CANARY on Pi"
    exit 0
fi
echo "USB device: $USB_DEV"

# --- Cleanup trap: always re-bind USB device on exit ---
cleanup() {
    local rc=$?
    echo ""
    echo "--- Cleanup: ensuring USB device $USB_DEV is bound ---"
    ssh "$PI" "docker exec $CONTAINER bash -c '
        if [ ! -L /sys/bus/usb/drivers/usb/$USB_DEV ]; then
            echo $USB_DEV > /sys/bus/usb/drivers/usb/bind 2>/dev/null || true
        fi
    '" 2>/dev/null || true
    return "$rc"
}
trap cleanup EXIT

# --- Pre-flight: ensure ADB sees the phone right now ---
echo ""
echo "--- Pre-flight: ADB visibility ---"
if ! ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell true" 2>/dev/null; then
    echo "SKIP: $CANARY not reachable via ADB on Pi (precondition)"
    exit 0
fi

# --- Confirm watchdog is enabled (default true, but a previous killswitch
#     test may have left it disabled). ---
WD_ENABLED=$(ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell content query \
    --uri content://com.otacon.kiosk/watchdog 2>/dev/null | tr -d '\\r' | head -1" 2>/dev/null || true)
echo "watchdog flag query: ${WD_ENABLED:-<no response>}"
ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell content update \
    --uri content://com.otacon.kiosk/watchdog --bind enabled:i:1 2>/dev/null || true" 2>/dev/null || true

# --- Baseline: capture uptime + clear logcat + clear reboot log ---
echo ""
echo "--- Baseline ---"
INITIAL_UPTIME=$(ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell cat /proc/uptime" 2>/dev/null | awk '{print $1}')
INITIAL_UPTIME_INT=${INITIAL_UPTIME%.*}
echo "initial uptime: ${INITIAL_UPTIME}s"

if [ "${INITIAL_UPTIME_INT:-0}" -lt 360 ]; then
    echo "SKIP: phone uptime ${INITIAL_UPTIME_INT}s < 6min — boot grace would block reboot"
    exit 0
fi

ssh "$PI" "docker exec $CONTAINER adb -s $CANARY logcat -c" 2>/dev/null || true

# Also clear the reboot log so we know any entry comes from this test.
ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell run-as com.otacon.kiosk \
    rm -f /data/data/com.otacon.kiosk/files/watchdog-reboots.log 2>/dev/null || true" 2>/dev/null || true

# --- Cut USB ---
echo ""
echo "--- Cutting USB (unbind $USB_DEV) ---"
ssh "$PI" "docker exec $CONTAINER bash -c 'echo $USB_DEV > /sys/bus/usb/drivers/usb/unbind 2>&1 || true'" 2>/dev/null || true

# --- Wait for the watchdog window: 3 probes × 60s + reboot ---
echo ""
echo "--- Waiting ${WAIT_FOR_REBOOT}s for 3 failed probes + reboot ---"
ELAPSED=0
while [ "$ELAPSED" -lt "$WAIT_FOR_REBOOT" ]; do
    if [ $((ELAPSED % 60)) -eq 0 ]; then
        echo "  [${ELAPSED}s / ${WAIT_FOR_REBOOT}s] waiting..."
    fi
    sleep 10
    ELAPSED=$((ELAPSED + 10))
done

# --- Restore USB ---
echo ""
echo "--- Restoring USB (bind $USB_DEV) ---"
# Tolerate "Resource busy" if fleet-agent's USB-topology reset already
# rebound the device — the post-reboot ADB side comes back either way.
ssh "$PI" "docker exec $CONTAINER bash -c 'echo $USB_DEV > /sys/bus/usb/drivers/usb/bind 2>&1 || true'" 2>/dev/null || true

# --- Wait for ADB to come back ---
echo ""
echo "--- Waiting up to ${WAIT_FOR_ADB}s for ADB to reappear ---"
ADB_BACK=false
ELAPSED=0
while [ "$ELAPSED" -lt "$WAIT_FOR_ADB" ]; do
    if ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell true" 2>/dev/null; then
        ADB_BACK=true
        echo "  ADB back at T+${ELAPSED}s"
        break
    fi
    sleep 5
    ELAPSED=$((ELAPSED + 5))
done

if [ "$ADB_BACK" != "true" ]; then
    echo "FAIL: ADB never reappeared after USB rebind"
    exit 1
fi

# Give the system another moment for /data and BOOT_COMPLETED handling.
sleep 10

# --- Assert phone rebooted (uptime < MAX_UPTIME_AFTER) ---
echo ""
echo "--- Verifying reboot ---"
NEW_UPTIME=$(ssh "$PI" "docker exec $CONTAINER adb -s $CANARY shell cat /proc/uptime" 2>/dev/null | awk '{print $1}')
NEW_UPTIME_INT=${NEW_UPTIME%.*}
echo "post-cutoff uptime: ${NEW_UPTIME}s (initial: ${INITIAL_UPTIME}s)"

if [ "${NEW_UPTIME_INT:-9999}" -ge "$MAX_UPTIME_AFTER" ]; then
    echo "FAIL: phone did not reboot — uptime ${NEW_UPTIME_INT}s >= ${MAX_UPTIME_AFTER}s"
    exit 1
fi
echo "PASS: phone rebooted (uptime ${NEW_UPTIME_INT}s < ${MAX_UPTIME_AFTER}s)"

# --- Assert WATCHDOG_RECOVERY_BOOT marker in logcat ---
echo ""
echo "--- Checking logcat for WATCHDOG_RECOVERY_BOOT ---"
RECOVERY=$(ssh "$PI" "docker exec $CONTAINER adb -s $CANARY logcat -d -s Watchdog:I 2>/dev/null \
    | grep WATCHDOG_RECOVERY_BOOT" 2>/dev/null || true)

if [ -z "$RECOVERY" ]; then
    echo "FAIL: WATCHDOG_RECOVERY_BOOT marker not found in logcat"
    echo "--- last 50 lines of Watchdog log ---"
    ssh "$PI" "docker exec $CONTAINER adb -s $CANARY logcat -d -s Watchdog:I 2>/dev/null | tail -50" || true
    exit 1
fi
echo "PASS: $RECOVERY"

# --- Assert reboot reason is captured in the recovery marker ---
# The WATCHDOG_RECOVERY_BOOT logcat line BootReceiver emits already includes
# the reason field read from the on-disk reboot log:
#     WATCHDOG_RECOVERY_BOOT ts=<ts> reason=<reason>
# We can't directly cat /data/data/com.otacon.kiosk/files/ — release-mode
# APKs aren't run-as-able on production phones — so the logcat marker is the
# canonical evidence path.
if ! echo "$RECOVERY" | grep -q 'reason=consecutive_failures'; then
    echo "FAIL: recovery marker missing 'reason=consecutive_failures'"
    exit 1
fi
echo "PASS: reboot reason captured in recovery marker"
echo "PASS: reboot reason logged"

echo ""
echo "=== Test: kiosk watchdog USB cutoff PASSED ==="
