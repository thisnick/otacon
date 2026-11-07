---
"otacon-server": patch
---

fleet-agent: resets a phone's Bluetooth dongle when its controller is wedged. After a failed pair or reconnect, it pings the phone from that dongle; "Operation already in progress" twice with no connection, or 5 failures in a row, triggers `hciconfig hciN reset` (at most once per 10 minutes per dongle) and a `bluetooth.adapter_reset` event. Before, a wedged dongle failed every pair until someone reset it by hand. Also, a failed or timed-out `dumpsys bluetooth_manager` no longer counts as the phone having lost its bond, which used to wipe every Bluetooth bond on the phone (`pm clear` on Samsung).
