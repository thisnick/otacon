"""Idempotent heal functions. Each fixes the matching health check."""

import logging

from ..bluetooth.pair import allocate_and_pair_bluetooth
from ..steps.wifi import connect_wifi
from ..steps.provisioning import provision_device_owner, apply_restrictions
from ..steps.snapshot import start_snapshot_server, setup_port_forwards

log = logging.getLogger('fleet-agent')


def heal_bt_bonded(serial: str, snapshot_url: str,
                    report_error=None) -> tuple[str | None, str | None, str | None]:
    """Re-pair bluetooth. Returns (adapter_mac, adapter_hci, phone_bt_mac)."""
    log.info(f'[{serial}] Healing: bt_bonded (re-pairing)')
    return allocate_and_pair_bluetooth(serial, snapshot_url, report_error=report_error)


def heal_bt_connected(adapter_mac: str | None, phone_bt_mac: str | None) -> bool:
    """Reconnect an existing bond via bluetoothctl."""
    import subprocess
    if not adapter_mac or not phone_bt_mac:
        return False
    log.info(f'Healing: bt_connected (reconnecting {phone_bt_mac})')
    try:
        result = subprocess.run(
            ['bluetoothctl'],
            input=f'select {adapter_mac}\nconnect {phone_bt_mac}\n',
            capture_output=True, text=True, timeout=15,
        )
        return 'successful' in (result.stdout or '').lower() or 'already connected' in (result.stdout or '').lower()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


def heal_wifi(serial: str):
    log.info(f'[{serial}] Healing: wifi (reconnecting)')
    connect_wifi(serial)


def heal_device_owner(serial: str):
    log.info(f'[{serial}] Healing: device_owner (re-provisioning)')
    provision_device_owner(serial)


def heal_restrictions(serial: str):
    log.info(f'[{serial}] Healing: restrictions (reapplying)')
    apply_restrictions(serial)


def heal_snapshot_alive(serial: str, snapshot_port: int, internal_port: int):
    log.info(f'[{serial}] Healing: snapshot_alive (restarting)')
    start_snapshot_server(serial)
    import time
    time.sleep(3)
    setup_port_forwards(serial, snapshot_port, internal_port)


def heal_port_forwards(serial: str, snapshot_port: int, internal_port: int):
    log.info(f'[{serial}] Healing: port_forwards (re-establishing)')
    setup_port_forwards(serial, snapshot_port, internal_port)
