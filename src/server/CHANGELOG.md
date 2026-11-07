# otacon-server

## 3.4.1

### Patch Changes

- ed7ac17: fleet-agent: the Bluetooth reconnect watcher keeps one retry per device and stops when BlueZ no longer has the device or it is no longer paired. Before, every re-pair added another listener and another retry loop that never ended, so a phone whose pairing kept failing built up dozens of loops calling ConnectProfile, which got in the way of the next pair attempt.

## 3.2.2

### Patch Changes

- cc4d16c: Preserve existing Bluetooth bonds during reconnects and repair stale bonds directly without repeatedly asking Android to make the phone discoverable.

## 2.1.0

## 2.0.0

### Major Changes

- Everything in the repo now shares one version and is released together: the npm packages, the host server, the registry and the orchestrator (docs/releasing.md).
- Previous server release: v1.0.0.

### Calls and voice

- HFP call control over Bluetooth: dial, answer, hang up, hold, swap, merge into a conference and DTMF, with call ids that survive merges.
- `ws/voice/control` and `ws/voice/monitor` sockets (`docs/voice-ws.md`): full-duplex call audio, command acks, marks, `clear`, and a stereo monitor.
- Call audio uses 20 ms ALSA periods. The monitor's played channel no longer has holes, and audio reaches the far end about 490 ms sooner.

### SIMs and connectivity

- eSIM install on Pixel phones through the Settings flow, with the dialogs confirmed automatically; `esim list --all` and status fields.
- SIM and phone-number listing on all OEMs; device identity (IMEI/EID).
- APN overrides with MMS fields; phone-local Wi-Fi on/off.
- SMS: sent messages are stored; default-app support in the kiosk app.

### Fleet

- Reliable host → registry events: outbox, in-order delivery, a reconciler and snapshots.
- A transport-agnostic host `address`; disconnected phones stay visible; deleting a phone works end to end.
- Bluetooth binding fixes and a kiosk watchdog.
- Phone tools: `.apkm` installs, `screen_state` in info, `swipe --pause`, longer recordings, rotation lock.
