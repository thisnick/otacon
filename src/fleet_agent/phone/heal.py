"""Idempotent heal functions. Each fixes the matching health check."""

import logging
import time

from ..util.adb import run_cmd
from ..bluetooth.controller import teardown_stale_link
from ..bluetooth.pair import allocate_and_pair_bluetooth, disable_discoverable
from . import health
from ..steps.wifi import connect_wifi
from ..steps.provisioning import provision_device_owner, apply_restrictions
from ..steps.snapshot import start_snapshot_server, setup_port_forwards

log = logging.getLogger('fleet-agent')


def heal_bt_silent(adapter_mac: str | None) -> bool:
    """Disable discoverable on the adapter."""
    if not adapter_mac:
        return True
    log.info(f'Healing: bt_silent (disabling discoverable on {adapter_mac})')
    disable_discoverable(adapter_mac)
    return True


def heal_bt_bonded(serial: str, snapshot_url: str,
                    report_error=None,
                    force_repair: bool = False) -> tuple[str | None, str | None, str | None, str | None]:
    """Restore missing bonds. Returns (adapter_mac, adapter_hci, phone_bt_mac, replaced_mac).

    Before re-pairing, detects if the phone is bonded to a wrong dongle
    and cleans up Pi-side bonds on wrong adapters. The assigned phone-side
    bond is cleared only when a replacement is needed, with ``pm clear``
    as an OEM fallback. An existing bond on both sides is retained unless
    ``force_repair=True`` (used after a link-key mismatch is proven).
    """
    log.info(f'[{serial}] Healing: bt_bonded '
             f'({"forcing re-pair" if force_repair else "checking before re-pairing"})')
    return allocate_and_pair_bluetooth(
        serial, snapshot_url, report_error=report_error, force_repair=force_repair)


def heal_bt_connected(adapter_mac: str | None, phone_bt_mac: str | None,
                      adapter_hci: str | None = None,
                      serial: str | None = None) -> bool:
    """Reconnect an existing bond via bluetoothctl.

    If BlueZ still thinks the device is connected (zombie half-open ACL or
    unencrypted link), tears down the stale link first so `connect` actually
    re-establishes it. Verifies the resulting link is connected, encrypted,
    and agreed on by the phone.
    """
    if not adapter_mac or not phone_bt_mac:
        return False
    log.info(f'Healing: bt_connected (reconnecting {phone_bt_mac})')

    # Tear down any stale BlueZ connection (e.g. zombie ACL) before reconnecting.
    try:
        pre = run_cmd(
            ['bluetoothctl'],
            input=f'select {adapter_mac}\ninfo {phone_bt_mac}\n',
            timeout=10,
        )
        if 'Connected: yes' in (pre.stdout or ''):
            teardown_stale_link(adapter_mac, adapter_hci, phone_bt_mac)
            time.sleep(1)
    except Exception:
        pass

    try:
        run_cmd(
            ['bluetoothctl'],
            input=f'select {adapter_mac}\nconnect {phone_bt_mac}\n',
            timeout=15,
        )
    except Exception:
        pass

    if adapter_hci or serial:
        # Give authentication/profile setup a moment to complete (or drop on
        # EACCES/ECONNREFUSED) before checking the link.
        time.sleep(2)

    connected = health.check_bt_connected(
        adapter_mac, phone_bt_mac, serial=serial, adapter_hci=adapter_hci)
    if not connected:
        log.warning(f'bt_connected heal: connect command ran but device not connected')
    return connected


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
    time.sleep(3)
    setup_port_forwards(serial, snapshot_port, internal_port)


def heal_port_forwards(serial: str, snapshot_port: int, internal_port: int):
    log.info(f'[{serial}] Healing: port_forwards (re-establishing)')
    setup_port_forwards(serial, snapshot_port, internal_port)
