"""Idempotent health-check functions. Each returns bool (healthy or not)."""

import logging
import os
import subprocess

from ..util.adb import adb, adb_shell
from ..steps.provisioning import DEVICE_OWNER_PKG

log = logging.getLogger('fleet-agent')


def check_bt_bonded(adapter_mac: str | None, phone_bt_mac: str | None) -> bool:
    """Bond exists in /var/lib/bluetooth."""
    if not adapter_mac or not phone_bt_mac:
        return False
    bond_dir = f'/var/lib/bluetooth/{adapter_mac.upper()}/{phone_bt_mac.upper()}'
    return os.path.isdir(bond_dir)


def check_bt_connected(adapter_mac: str | None, phone_bt_mac: str | None) -> bool:
    """BT link is active (D-Bus Connected=true)."""
    if not adapter_mac or not phone_bt_mac:
        return False
    try:
        result = subprocess.run(
            ['bluetoothctl'],
            input=f'select {adapter_mac}\ninfo {phone_bt_mac}\n',
            capture_output=True, text=True, timeout=10,
        )
        return 'Connected: yes' in (result.stdout or '')
    except (subprocess.TimeoutExpired, FileNotFoundError):
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
    """DPM restrictions applied (query kiosk app)."""
    result = adb_shell(
        serial,
        f"content query --uri 'content://com.otacon.kiosk/restrictions/status'",
        timeout=5,
    )
    if not result:
        return False
    return 'active=true' in result


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
