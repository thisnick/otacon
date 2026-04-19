#!/usr/bin/env bash
# Hardware test: Full kiosk restriction set verification (all 3 phones)
#
# Verifies that check_restrictions detects missing restrictions and that
# heal_restrictions restores them on ALL phones in the fleet.
#
# Current state before fix:
#   - Pixel: ZERO Device policy restrictions
#   - S22: only no_config_location, no_config_wifi
#   - A14: no_config_bluetooth, no_config_location, no_config_wifi
#
# After the fix, all 3 should converge to the full 8-restriction set within
# one maintenance tick (~30s). This test is a natural canary — no need to
# artificially clear restrictions since Pixel and S22 are already broken.
#
# IMPORTANT: Parses the "Device policy restrictions:" section of dumpsys user,
# NOT the "Effective restrictions:" section (which includes system-applied
# restrictions like no_factory_reset that mask the bug).
#
# Usage: ./test_full_restrictions.sh
# Requires: curl, jq, ssh access to otacon-pi

set -euo pipefail

PI="nick@otacon-pi"
source "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/lib/tailscale.sh"
MAX_WAIT=120  # seconds

# All 3 phones in the fleet
declare -A PHONES
PHONES[phone-14151jec]="14151JEC200486"
PHONES[phone-r92x1022]="R92X1022S7K"
PHONES[phone-r5ct60sd]="R5CT60SDGKD"

# The full restriction set from BootReceiver.java USER_RESTRICTIONS[]
EXPECTED_RESTRICTIONS=(
    no_config_wifi
    no_config_bluetooth
    no_config_location
    no_factory_reset
    no_safe_boot
    no_usb_file_transfer
    no_airplane_mode
    no_config_tethering
)

# Parse "Device policy restrictions:" (Samsung) or "Device policy global/local
# restrictions:" (Pixel/AOSP) sections from dumpsys user output.
# Skips "Effective restrictions:" which includes system-applied ones.
parse_device_policy_restrictions() {
    local dumpsys="$1"
    local in_section=false
    while IFS= read -r line; do
        # Match any Device policy *restrictions: header (but NOT Effective)
        if [[ "$line" == *"Device policy"*"restrictions:"* ]] && [[ "$line" != *"Effective"* ]]; then
            in_section=true
            continue
        fi
        # Skip "Effective restrictions:" section
        if [[ "$line" == *"Effective restrictions:"* ]]; then
            in_section=false
            continue
        fi
        if [ "$in_section" = true ]; then
            stripped="${line#"${line%%[![:space:]]*}"}"
            # Skip empty lines and section-ending non-indented lines
            if [ -z "$stripped" ]; then
                continue
            fi
            if [[ "$line" != " "* ]] && [[ "$line" != $'\t'* ]]; then
                in_section=false
                continue
            fi
            # Skip "User Id:" lines in local restrictions section
            if [[ "$stripped" == "User Id:"* ]]; then
                continue
            fi
            # Extract no_* restriction key
            if [[ "$stripped" =~ ^(no_[a-z_]+) ]]; then
                echo "${BASH_REMATCH[1]}"
            fi
        fi
    done <<< "$dumpsys"
}

echo "=== Test: Full kiosk restriction set (all 3 phones) ==="

# Step 1: Snapshot initial state of all phones
echo ""
echo "--- Step 1: Initial restriction state ---"
ALL_INITIALLY_COMPLETE=true

for PHONE_ID in "${!PHONES[@]}"; do
    SERIAL="${PHONES[$PHONE_ID]}"
    echo ""
    echo "Phone: $PHONE_ID ($SERIAL)"

    DUMPSYS=$(ssh "$PI" "docker exec otacon-otacon-1 adb -s $SERIAL shell dumpsys user" 2>/dev/null)
    ACTIVE=$(parse_device_policy_restrictions "$DUMPSYS")

    MISSING=()
    for r in "${EXPECTED_RESTRICTIONS[@]}"; do
        if echo "$ACTIVE" | grep -q "^${r}$"; then
            echo "  $r: present (device policy)"
        else
            echo "  $r: MISSING (device policy)"
            MISSING+=("$r")
        fi
    done

    if [ ${#MISSING[@]} -gt 0 ]; then
        echo "  -> ${#MISSING[@]} restrictions missing: ${MISSING[*]}"
        ALL_INITIALLY_COMPLETE=false
    else
        echo "  -> all ${#EXPECTED_RESTRICTIONS[@]} restrictions present"
    fi
done

if [ "$ALL_INITIALLY_COMPLETE" = true ]; then
    echo ""
    echo "All phones already have full restriction set."
    echo "Running force-remove test on A14 to verify detection + heal..."

    # Force-clear ALL restrictions on A14 via kiosk app broadcast, then verify
    # fleet-agent detects and re-applies them
    A14_SERIAL="R92X1022S7K"
    A14_PHONE="phone-r92x1022"
    echo ""
    echo "--- Force-clear all restrictions on A14 via kiosk broadcast ---"
    ssh "$PI" "docker exec otacon-otacon-1 adb -s $A14_SERIAL shell am broadcast -a com.otacon.kiosk.CLEAR_RESTRICTIONS -n com.otacon.kiosk/.BootReceiver" 2>/dev/null || true
    sleep 3

    DUMPSYS=$(ssh "$PI" "docker exec otacon-otacon-1 adb -s $A14_SERIAL shell dumpsys user" 2>/dev/null)
    ACTIVE=$(parse_device_policy_restrictions "$DUMPSYS")
    STILL_COUNT=$(echo "$ACTIVE" | grep -c "^no_" || true)
    if [ "$STILL_COUNT" -ge "${#EXPECTED_RESTRICTIONS[@]}" ]; then
        echo "FAIL: restrictions still present after CLEAR_RESTRICTIONS broadcast ($STILL_COUNT found)"
        exit 1
    fi
    echo "Confirmed: restrictions cleared on A14 ($STILL_COUNT remaining, was ${#EXPECTED_RESTRICTIONS[@]})"
    echo "Waiting 30s for fleet-agent to detect the cleared restrictions..."
    sleep 30
fi

# Step 2: Wait for fleet-agent to detect and heal all phones
echo ""
echo "--- Step 2: Wait for fleet-agent to heal all phones (up to ${MAX_WAIT}s) ---"

START=$(date +%s)
ALL_HEALED=false

while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - START))
    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
        break
    fi

    ALL_GOOD=true
    for PHONE_ID in "${!PHONES[@]}"; do
        INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
        RESTRICTIONS=$(echo "$INFO" | jq -r 'if .monitor.health.restrictions == true then "true" elif .monitor.health.restrictions == false then "false" else "unknown" end')
        if [ "$RESTRICTIONS" != "true" ]; then
            ALL_GOOD=false
        fi
    done

    if [ "$ALL_GOOD" = true ]; then
        ALL_HEALED=true
        echo "All phones report restrictions=true at T+${ELAPSED}s"
        break
    fi

    # Print status every 10s
    if [ $((ELAPSED % 10)) -lt 6 ]; then
        STATUS=""
        for PHONE_ID in "${!PHONES[@]}"; do
            INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
            R=$(echo "$INFO" | jq -r 'if .monitor.health.restrictions == true then "true" elif .monitor.health.restrictions == false then "false" else "?" end')
            STATUS="$STATUS $PHONE_ID=$R"
        done
        echo "  [${ELAPSED}s]$STATUS"
    fi

    sleep 5
done

if [ "$ALL_HEALED" = false ]; then
    echo "FAIL: Not all phones healed within ${MAX_WAIT}s"
    for PHONE_ID in "${!PHONES[@]}"; do
        INFO=$(curl -sk "$PI_URL/phones/$PHONE_ID/api/info" 2>/dev/null)
        R=$(echo "$INFO" | jq -r 'if .monitor.health.restrictions == true then "true" elif .monitor.health.restrictions == false then "false" else "?" end')
        echo "  $PHONE_ID: restrictions=$R"
    done
    exit 1
fi

# Step 3: Verify actual device policy restrictions on all phones
echo ""
echo "--- Step 3: Verify device policy restrictions on all phones ---"
OVERALL_PASS=true

for PHONE_ID in "${!PHONES[@]}"; do
    SERIAL="${PHONES[$PHONE_ID]}"
    echo ""
    echo "Phone: $PHONE_ID ($SERIAL)"

    DUMPSYS=$(ssh "$PI" "docker exec otacon-otacon-1 adb -s $SERIAL shell dumpsys user" 2>/dev/null)
    ACTIVE=$(parse_device_policy_restrictions "$DUMPSYS")

    MISSING=()
    for r in "${EXPECTED_RESTRICTIONS[@]}"; do
        if echo "$ACTIVE" | grep -q "^${r}$"; then
            echo "  $r: present"
        else
            echo "  $r: MISSING"
            MISSING+=("$r")
        fi
    done

    if [ ${#MISSING[@]} -gt 0 ]; then
        echo "  FAIL: ${#MISSING[@]} restrictions missing: ${MISSING[*]}"
        OVERALL_PASS=false
    else
        echo "  PASS: all ${#EXPECTED_RESTRICTIONS[@]} restrictions present"
    fi
done

TOTAL=$(($(date +%s) - START))

if [ "$OVERALL_PASS" = false ]; then
    echo ""
    echo "FAIL: Not all phones have the full restriction set"
    exit 1
fi

echo ""
echo "PASS: All 3 phones have full ${#EXPECTED_RESTRICTIONS[@]}-restriction kiosk set (verified via Device policy restrictions section)"
echo "=== Test: Full kiosk restriction set PASSED (${TOTAL}s) ==="
