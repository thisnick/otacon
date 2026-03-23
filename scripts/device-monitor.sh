#!/bin/bash
# device-monitor.sh — Watches for ADB device connect/disconnect events.
# Runs as a supervised daemon. On each new connection:
#   1. Provisions device owner if needed
#   2. Updates APK
#   3. Enables services
#   4. Sets up port forward
#   5. Connects WiFi
#   6. Applies restrictions
#   7. Monitors connection — loops back on disconnect

TAG="device-monitor"
log() { echo "$(date +%H:%M:%S) ${TAG}: $*"; }

LAST_SERIAL=""

while true; do
    # Wait for a device
    while ! adb devices 2>/dev/null | grep -q 'device$'; do
        sleep 2
    done

    SERIAL=$(adb devices | grep 'device$' | head -1 | awk '{print $1}')

    # Skip if same device still connected (no state change)
    if [ "$SERIAL" = "$LAST_SERIAL" ]; then
        # Just verify it's still there
        if adb -s "$SERIAL" get-state 2>/dev/null | grep -q "device"; then
            sleep 5
            continue
        else
            # Device disconnected
            log "Device ${LAST_SERIAL} disconnected"
            LAST_SERIAL=""
            continue
        fi
    fi

    log "New device connected: ${SERIAL}"
    LAST_SERIAL="$SERIAL"

    # Give the device a moment to fully initialize
    sleep 2

    # --- Keep screen on ---
    adb shell settings put system screen_off_timeout 2147483647 2>/dev/null || true
    adb shell svc power stayon usb 2>/dev/null || true
    adb shell input keyevent 26 2>/dev/null || true  # wake screen

    # --- Device Owner provisioning ---
    if ! adb shell dpm list-owners 2>/dev/null | grep -q "com.otacon.kiosk"; then
        log "Device owner not set — provisioning..."
        ACCOUNT_COUNT=$(adb shell dumpsys account 2>/dev/null | grep -c "Account {" || true)
        if [ "${ACCOUNT_COUNT:-0}" -gt 0 ]; then
            log "ERROR: Phone has $ACCOUNT_COUNT account(s). Factory reset required."
        elif [ -f /opt/otacon-kiosk.apk ]; then
            adb install -r /opt/otacon-kiosk.apk
            adb shell dpm set-device-owner com.otacon.kiosk/.DeviceOwnerReceiver
            adb shell settings put secure enabled_accessibility_services \
                com.otacon.kiosk/.OtaconAccessibilityService
            adb shell cmd notification allow_listener \
                com.otacon.kiosk/.OtaconNotificationListener 2>/dev/null || true
            log "Device owner provisioned"
        else
            log "WARNING: /opt/otacon-kiosk.apk not found"
        fi
    else
        log "Device owner already set"
        # Update APK to latest version
        if [ -f /opt/otacon-kiosk.apk ]; then
            adb install -r /opt/otacon-kiosk.apk 2>/dev/null && log "APK updated" || true
        fi
    fi

    # --- ADB port forward ---
    adb forward tcp:9090 tcp:9090 2>/dev/null || true
    log "Port forward established"

    # Wait for device owner HTTP server to come up
    for i in $(seq 1 10); do
        if curl -s http://127.0.0.1:9090/health 2>/dev/null | grep -q '"ok"'; then
            log "Bridge connected"
            break
        fi
        sleep 1
    done

    # --- Connect WiFi ---
    if [ -n "${WIFI_AP_SSID:-}" ]; then
        log "Connecting WiFi '${WIFI_AP_SSID}'..."
        if curl -s -X POST -H 'Content-Type: application/json' \
            -d "{\"ssid\":\"${WIFI_AP_SSID}\",\"password\":\"${WIFI_AP_PASSWORD}\"}" \
            http://127.0.0.1:9090/wifi/connect 2>/dev/null | grep -q '"ok"'; then
            log "WiFi connected via bridge"
        else
            adb shell cmd wifi connect-network "${WIFI_AP_SSID}" wpa2 "${WIFI_AP_PASSWORD}" 2>/dev/null || true
        fi
    fi

    # --- Apply restrictions (after WiFi) ---
    if adb shell dpm list-owners 2>/dev/null | grep -q "com.otacon.kiosk"; then
        adb shell am broadcast -a com.otacon.kiosk.APPLY_RESTRICTIONS \
            -n com.otacon.kiosk/.BootReceiver 2>/dev/null || true
        log "Restrictions applied"
    fi

    # --- Auto-detect Bluetooth MAC ---
    if [ "$AUDIO_BACKEND" = "bluetooth" ]; then
        PHONE_BT_MAC=$(adb shell settings get secure bluetooth_address 2>/dev/null | tr -d '\r')
        if [ -n "$PHONE_BT_MAC" ] && [ "$PHONE_BT_MAC" != "null" ]; then
            log "Phone BT MAC: $PHONE_BT_MAC"
        fi
    fi

    log "Device setup complete"

    # --- Monitor connection ---
    while adb -s "$SERIAL" get-state 2>/dev/null | grep -q "device"; do
        # Re-establish port forward if lost
        adb forward tcp:9090 tcp:9090 2>/dev/null || true
        sleep 10
    done

    log "Device ${SERIAL} disconnected"
    LAST_SERIAL=""
    sleep 2
done
