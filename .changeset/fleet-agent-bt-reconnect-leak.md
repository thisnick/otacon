---
"otacon-server": patch
---

fleet-agent: the Bluetooth reconnect watcher keeps one retry per device and stops when BlueZ no longer has the device or it is no longer paired. Before, every re-pair added another listener and another retry loop that never ended, so a phone whose pairing kept failing built up dozens of loops calling ConnectProfile, which got in the way of the next pair attempt.
