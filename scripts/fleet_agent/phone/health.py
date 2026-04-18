"""Idempotent health-check functions. Each returns bool (healthy or not)."""

import logging
import os

from ..util.adb import adb, adb_shell, run_cmd
from ..steps.provisioning import DEVICE_OWNER_PKG

log = logging.getLogger('fleet-agent')


def check_bt_bonded(adapter_mac: str | None, phone_bt_mac: str | None,
                     serial: str | None = None) -> bool:
    """Bond exists on both Pi (BlueZ) and phone sides.

    Checks three signals to avoid false positives from one-sided state:
    1. /var/lib/bluetooth dir exists (Pi filesystem)
    2. bluetoothctl reports Paired: yes (BlueZ D-Bus)
    3. Phone reports the adapter as bonded (Android dumpsys) — optional
    """
    if not adapter_mac or not phone_bt_mac:
        return False

    # 1. Filesystem check
    bond_dir = f'/var/lib/bluetooth/{adapter_mac.upper()}/{phone_bt_mac.upper()}'
    if not os.path.isdir(bond_dir):
        return False

    # 2. BlueZ D-Bus check — the authoritative Pi-side source
    try:
        result = run_cmd(
            ['bluetoothctl'],
            input=f'select {adapter_mac}\ninfo {phone_bt_mac}\n',
            timeout=10,
        )
        if 'Paired: yes' not in (result.stdout or ''):
            log.debug(f'bt_bonded: dir exists but BlueZ says not paired')
            return False
    except Exception:
        return False

    # 3. Phone-side cross-check (optional — log mismatch but don't block)
    if serial:
        try:
            bt_dump = adb_shell(serial, 'dumpsys bluetooth_manager', timeout=5)
            if adapter_mac.upper() not in bt_dump.upper():
                log.warning(f'bt_bonded: Pi paired but phone has no record of {adapter_mac}')
        except Exception:
            pass  # non-fatal

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


def check_restrictions(serial: str) -> bool:
    """DPM restrictions applied (check user restrictions via dumpsys)."""
    result = adb_shell(serial, 'dumpsys user', timeout=5)
    if not result:
        return False
    # DISALLOW_FACTORY_RESET is always in the restriction set — if it's
    # present the kiosk app has applied its restrictions successfully.
    return 'no_factory_reset' in result


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
