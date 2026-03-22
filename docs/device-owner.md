# Device Owner App

The app lives at `android/device-owner/`. It is provisioned once via:
```bash
adb shell dpm set-device-owner com.otacon.kiosk/.DeviceOwnerReceiver
```

## What's already implemented

- `DISALLOW_CONFIG_WIFI` — prevent changing WiFi
- `DISALLOW_CONFIG_BLUETOOTH` — prevent changing BT settings
- `DISALLOW_CONFIG_LOCATION` — prevent changing location
- `DISALLOW_FACTORY_RESET` — block factory reset
- `DISALLOW_INSTALL_APPS` — block sideloading / Play Store installs
- `DISALLOW_SAFE_BOOT` — block safe mode
- `DISALLOW_USB_FILE_TRANSFER` — block USB file transfer
- `DISALLOW_ADJUST_VOLUME` — lock volume
- `DISALLOW_AIRPLANE_MODE` — prevent airplane mode
- `DISALLOW_CONFIG_TETHERING` — prevent hotspot/tethering
- Camera disabled
- WiFi disabled

## TODO: Bluetooth pairing

Currently `make bluetooth-pair` requires:
1. Opening BT settings on the phone (to make it discoverable)
2. Waiting for the Pi to find it via `hcitool inq`
3. Tapping the "Pair" dialog via ADB

With Device Owner, this can be fully automated:
- `BluetoothAdapter.startDiscovery()` — find the Pi without user interaction
- `BluetoothDevice.createBond()` — pair without showing a dialog
- `BluetoothDevice.setPairingConfirmation(true)` via `BluetoothDevice.ACTION_PAIRING_REQUEST` broadcast — auto-confirm pairing

This eliminates the BT settings screen step entirely and makes pairing hands-free.

## TODO: BT stays managed despite DISALLOW_CONFIG_BLUETOOTH

`DISALLOW_CONFIG_BLUETOOTH` prevents the user from changing BT settings but still
allows the device owner app to manage BT programmatically. The Pi can still pair and
connect from the device owner app.

## TODO: Auto-connect on boot

After pairing is done once, the phone should auto-reconnect to the Pi on every reboot.
Device Owner can ensure BT is on and trusted devices are maintained.

## TODO: Keep screen on / prevent sleep during calls

`dpm.setMaximumTimeToLock(admin, 0)` — disable screen lock timeout.
Or use `DISALLOW_LOCK_SCREEN` restriction.

## TODO: Suppress system dialogs / notifications

- Dismiss any unexpected system popups automatically
- Suppress low battery warning, update prompts, etc.

## TODO: WiFi auto-connect (headless, no ADB)

Currently the Pi connects the phone to the AP via ADB:
```bash
adb shell cmd wifi connect-network "${WIFI_AP_SSID}" wpa2 "${WIFI_AP_PASSWORD}"
```
This saves credentials permanently and auto-connects on future boots, but requires USB.

For fully headless boot (no USB cable), Device Owner can add the network programmatically
before `DISALLOW_CONFIG_WIFI` is applied:

1. `dpm.setWifiEnabled(admin, true)` — ensure WiFi is on
2. `dpm.addWifiNetworkPrivileged(admin, suggestion)` (API 33 / Android 13) — add the
   Pi AP credentials silently without user interaction
3. Apply `DISALLOW_CONFIG_WIFI` after — user cannot change or remove it

This path requires Android 13+ and the Device Owner app to know the AP credentials
(pass via intent or bake into the APK via BuildConfig).

## TODO: AccessibilityService for fast UI tree + actions

Currently the server gets the accessibility tree via `adb exec-out uiautomator dump`
which takes ~2.5s per call (full serialization + process spawn overhead). The device
owner app can register an `AccessibilityService` that is dramatically faster and
enables features not possible via ADB:

**Fast tree access (~100-200ms vs 2.5s):**
- `getRootInActiveWindow()` returns the live in-memory tree — no serialization, no process spawn
- Can query subtrees or individual nodes instead of dumping everything
- Can filter to only return interactive nodes, reducing payload size

**Real-time UI change events (eliminates polling):**
- `onAccessibilityEvent()` receives callbacks for `TYPE_WINDOW_CONTENT_CHANGED`,
  `TYPE_VIEW_CLICKED`, `TYPE_VIEW_SCROLLED`, etc.
- Server can be notified of UI changes instantly instead of re-dumping the tree
- Enables the `/ws/events` stream for `app.foreground` changes

**Direct node actions (more reliable than coordinate taps):**
- `node.performAction(AccessibilityNodeInfo.ACTION_CLICK)` — works even if element
  is partially obscured or overlapped by another window
- `ACTION_LONG_CLICK`, `ACTION_SCROLL_FORWARD`, `ACTION_SET_TEXT` — direct manipulation
  without coordinate mapping
- `ACTION_SET_SELECTION`, `ACTION_PASTE` — clipboard interaction

**Architecture:**
The device owner app runs a lightweight HTTP server on localhost (e.g., port 9090).
The Rust server on the Pi connects via ADB port forwarding:
```bash
adb forward tcp:9090 tcp:9090
```
Then calls `http://localhost:9090/snapshot`, `http://localhost:9090/action`, etc.
The Rust server's API stays the same — clients don't know whether the backend
uses ADB commands or the device owner app.

**Permission:** Device Owner can grant itself accessibility access via
`DevicePolicyManager.setPermittedAccessibilityServices()` — no manual Settings toggle.

## TODO: Notification management via NotificationListenerService

The device owner app can register a `NotificationListenerService` to:
- Receive real-time notification events (posted, removed, updated)
- Dismiss notifications programmatically (`cancelNotification(key)`)
- Read notification action buttons and trigger them (`Notification.Action`)
- Feed events to `/ws/events` stream (`notification.received`, `notification.removed`)

Currently `GET /api/notifications` parses `dumpsys notification --noredact` output,
and `DELETE /api/notifications/:key` is deferred. With a NotificationListenerService
both become fast and reliable.

**Permission:** Device Owner grants itself notification access via
`DevicePolicyManager.setPermittedNotificationListeners()`.

## TODO: Clipboard access via ClipboardManager

No ADB command can read/write the clipboard on Android 10+. The device owner app
can access `ClipboardManager` directly:
- `clipboardManager.getPrimaryClip()` — read
- `clipboardManager.setPrimaryClip(ClipData.newPlainText(...))` — write

This enables `GET /api/clipboard` and `PUT /api/clipboard`.

Scrcpy solves this via `app_process` (runs Java with shell permissions), but bundling
it in the device owner app is simpler and doesn't require a separate process.
