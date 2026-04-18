"""Idempotent health-check functions. Each returns bool (healthy or not)."""

import logging
import os
import re

from ..util.adb import adb, adb_shell, run_cmd
from ..steps.provisioning import DEVICE_OWNER_PKG

log = logging.getLogger('fleet-agent')

# Ground truth: the dumpsys-user restriction keys that BootReceiver.java applies.
# Must match USER_RESTRICTIONS[] in BootReceiver exactly.
KIOSK_RESTRICTION_SET = frozenset({
    'no_config_wifi',
    'no_config_bluetooth',
    'no_config_location',
    'no_factory_reset',
    'no_safe_boot',
    'no_usb_file_transfer',
    'no_airplane_mode',
    'no_config_tethering',
})


def check_bt_bonded(adapter_mac: str | None, phone_bt_mac: str | None,
                     serial: str | None = None) -> bool:
    """Bond exists in BlueZ (Pi-side) via D-Bus.

    Uses bluetoothctl info as the authoritative source — the /var/lib/bluetooth
    filesystem dir is unreliable in Docker (ephemeral storage, USB dongle dirs
    may not be written). Also cross-checks the phone side via dumpsys.
    """
    if not adapter_mac or not phone_bt_mac:
        return False

    # BlueZ D-Bus check — the authoritative Pi-side source
    try:
        result = run_cmd(
            ['bluetoothctl'],
            input=f'select {adapter_mac}\ninfo {phone_bt_mac}\n',
            timeout=10,
        )
        stdout = result.stdout or ''
        if 'Paired: yes' not in stdout:
            return False
    except Exception:
        return False

    # Phone-side cross-check — if the phone has removed the bond, the Pi-side
    # bond is stale and reconnection will never succeed.  Failing here triggers
    # the bt_bonded heal (full re-pair) instead of futile bt_connected retries.
    if serial:
        try:
            bt_dump = adb_shell(serial, 'dumpsys bluetooth_manager', timeout=5)
            if adapter_mac.upper() not in bt_dump.upper():
                log.warning(f'bt_bonded: Pi paired but phone has no record of {adapter_mac} — stale bond')
                return False
        except Exception:
            pass  # can't reach phone — don't fail on that

    return True


def check_bt_connected(adapter_mac: str | None, phone_bt_mac: str | None) -> bool:
    """BT link is active (D-Bus Connected=true)."""
    if not adapter_mac or not phone_bt_mac:
        return False
    try:
        result = run_cmd(
            ['bluetoothctl'],
            input=f'select {adapter_mac}\ninfo {phone_bt_mac}\n',
            timeout=10,
        )
        return 'Connected: yes' in (result.stdout or '')
    except Exception:
        return False


def check_wifi_connected(serial: str) -> bool:
    """Phone's WiFi is connected."""
    ssid = os.environ.get('WIFI_AP_SSID', '')
    if not ssid:
        return True  # no WiFi configured, consider healthy
    out = adb_shell(serial, 'cmd wifi status')
    return 'Wifi is connected' in out


def check_device_owner(serial: str) -> bool:
    """Device owner is set."""
    output = adb_shell(serial, 'dpm list-owners')
    return DEVICE_OWNER_PKG in output


def _parse_device_policy_restrictions(dumpsys_output: str) -> set[str]:
    """Extract restriction keys from the 'Device policy restrictions:' section."""
    restrictions: set[str] = set()
    in_section = False
    for line in dumpsys_output.splitlines():
        stripped = line.strip()
        if stripped.startswith('Device policy restrictions:'):
            in_section = True
            continue
        if in_section:
            # Section ends at the next non-indented line or blank line
            if not stripped or (not line.startswith(' ') and not line.startswith('\t')):
                break
            # Lines look like "no_config_bluetooth: true" or just "no_factory_reset"
            match = re.match(r'(no_\w+)', stripped)
            if match:
                restrictions.add(match.group(1))
    return restrictions


def check_restrictions(serial: str) -> bool:
    """DPM restrictions applied — all kiosk restrictions must be present."""
    result = adb_shell(serial, 'dumpsys user', timeout=5)
    if not result:
        return False
    active = _parse_device_policy_restrictions(result)
    missing = KIOSK_RESTRICTION_SET - active
    if missing:
        log.warning(f'[{serial}] Missing DPM restrictions: {sorted(missing)}')
        return False
    return True


def check_snapshot_alive(serial: str) -> bool:
    """Snapshot server process alive on phone."""
    proc_check = adb_shell(serial, 'pgrep -f snapshot-server.jar')
    return bool(proc_check.strip())


def check_port_forwards(serial: str, snapshot_port: int, internal_port: int) -> bool:
    """ADB forward + reverse intact."""
    fwd = adb(serial, 'forward', '--list')
    rev = adb(serial, 'reverse', '--list')
    has_fwd = f'tcp:{snapshot_port}' in fwd
    has_rev = f'tcp:{internal_port}' in rev
    return has_fwd and has_rev
