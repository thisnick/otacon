---
"otacon-server": patch
---

fleet-agent: auto-heal zombie half-open Bluetooth ACL links and mismatched link keys. `check_bt_connected` now cross-checks `hcitool con` (`AUTH ENCRYPT`) and Android's `dumpsys bluetooth_manager` (`ConnectionState`) so a dead ACL handle or brief unencrypted connect no longer looks healthy; `heal_bt_connected` tears down stale `Connected: yes` links (via `bluetoothctl disconnect`, `l2ping` poke, and `hciconfig reset` fallback) before reconnecting. When reconnect still fails 3 times after an adapter reset while the phone answers `l2ping` (ruling out a wedged dongle or unreachable phone), `fleet-agent` emits `bluetooth.bond_repair` and forces a re-pair (at most once per 30 minutes per adapter).
