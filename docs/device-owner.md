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
- WiFi desired state managed by host-local Rust config and applied directly by the host

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

## WiFi provisioning under restrictions

The Device Owner ContentProvider keeps a small WiFi bridge for provisioning,
self-heal, and reliable on/off under restrictions. `src/fleet_agent/steps/wifi.py`
calls `wifi/connect` when normal `cmd wifi connect-network` is blocked or
unreliable. User-facing Wi-Fi connect/forget is intentionally not exposed.

```text
content://com.otacon.kiosk/wifi/status
content://com.otacon.kiosk/wifi/enabled?enabled=true|false
content://com.otacon.kiosk/wifi/connect?ssid=...&password=...
content://com.otacon.kiosk/wifi/forget?ssid=...
```

For mutating operations, the provider temporarily clears `DISALLOW_CONFIG_WIFI`,
performs the WiFi change, then restores the restriction.

## APN overrides

The Device Owner ContentProvider exposes Android `DevicePolicyManager` override
APNs for host-local APN management:

```text
content://com.otacon.kiosk/apns
content://com.otacon.kiosk/apns/create?name=SpeedTalk&operator=310240&apn=stkmobi
content://com.otacon.kiosk/apns/update?id=1&apn=...
content://com.otacon.kiosk/apns/delete?id=1
content://com.otacon.kiosk/apns/enabled?enabled=true|false
```

Supported APN fields include data settings (`types`, `protocol`,
`roamingProtocol`, `authType`, `user`, `password`) and MMS settings (`mmsc`,
`mmsProxy`, `mmsPort`). The provider auto-adds the `mms` APN type when any MMS
field is present.

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

**Smart cache invalidation (replaces brute-force TTL):**

The current ADB approach invalidates the entire snapshot cache after any action and
uses a 30s TTL. With accessibility events, invalidation becomes surgical:

- **Keep the tree live in memory** — the service holds the parsed tree and patches it
  incrementally on each event, rather than re-dumping from scratch
- **Invalidate only affected subtrees** — a scroll in a `RecyclerView` only invalidates
  refs inside that container. Refs outside it remain valid and usable.
- **Know the result of our own actions** — when the server sends a tap, the accessibility
  event tells us exactly what changed (dialog opened, checkbox toggled, list scrolled).
  Update only the affected nodes instead of throwing everything away.
- **Detect external changes** — if the user touches the phone or a notification pops up,
  the event identifies what changed. Invalidate only those refs.
- **No TTL needed** — the tree is always current because the service maintains it
  incrementally. The server reads from the live tree whenever the agent asks.

This changes the agent workflow from snapshot→act→re-snapshot (2.5s overhead per cycle)
to act→read (near-instant, tree is already up to date).

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
