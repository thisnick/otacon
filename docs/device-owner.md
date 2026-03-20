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
