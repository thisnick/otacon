"""Bluetooth pairing flow — replaces bluetooth-pair.sh and the
allocate_and_pair_bluetooth method from device-monitor.py."""

import json
import logging
import os
import re
import threading
import time
import urllib.parse

from ..util.adb import adb_shell, run_cmd
from ..util.http import http_get, http_post
from .dongle import (
    allocate_dongle, enum_dongles, get_cached_bt_mac,
    save_dongle_assignment,
)
from ..steps.provisioning import apply_restrictions
from ..steps.screen import ensure_screen_on

log = logging.getLogger('fleet-agent')

PHONES_JSON_PATH = os.environ.get('PHONES_CONFIG', '/data/otacon/phones.json')


def find_pair_button_in_tree(data) -> str | None:
    """Walk a snapshot a11y tree and find a clickable Pair/Allow button.

    Pure function — takes parsed JSON data, returns ref_id or None.
    """
    result = find_pair_button_with_bounds(data)
    return result[0] if result else None


def find_pair_button_with_bounds(data) -> tuple[str, dict] | None:
    """Walk a snapshot a11y tree and find a clickable Pair/Allow button.

    Returns (ref_id, bounds_dict) or None.
    """
    if not data:
        return None

    PAIR_TEXTS = {'pair', 'allow'}

    def walk(node):
        text = (node.get('text') or '').strip().lower()
        if text in PAIR_TEXTS and node.get('clickable'):
            ref = node.get('ref_id')
            bounds = node.get('bounds')
            if ref and bounds:
                return (ref, bounds)
        for child in node.get('children', []):
            result = walk(child)
            if result:
                return result
        return None

    nodes = data if isinstance(data, list) else [data]
    for node in nodes:
        result = walk(node)
        if result:
            return result
    return None


def _find_pair_button(snapshot_url: str) -> str | None:
    data = http_get(f'{snapshot_url}/snapshot?format=json', timeout=3)
    return find_pair_button_in_tree(data)


def _find_pair_button_with_bounds(snapshot_url: str) -> tuple[str, dict] | None:
    data = http_get(f'{snapshot_url}/snapshot?format=json', timeout=3)
    return find_pair_button_with_bounds(data)


def _tap_pair_notification(serial: str) -> bool:
    """Find a 'Pairing request' notification and trigger its Pair action."""
    try:
        text = adb_shell(
            serial,
            "content query --uri 'content://com.otacon.kiosk/notifications'",
            timeout=3,
        )
    except Exception:
        return False
    if not text:
        return False
    match = re.search(r'json=(\[.*\])', text)
    if not match:
        return False
    try:
        notifs = json.loads(match.group(1))
    except json.JSONDecodeError:
        return False
    for n in notifs:
        if n.get('package') != 'com.android.settings':
            continue
        title = (n.get('title') or '').lower()
        if 'pair' not in title:
            continue
        for action in n.get('actions') or []:
            atitle = (action.get('title') or '').lower()
            if 'pair' in atitle and 'cancel' not in atitle and 'block' not in atitle:
                key = n.get('key')
                idx = action.get('index')
                if key is None or idx is None:
                    continue
                enc_key = urllib.parse.quote(str(key), safe='')
                log.info(f"Triggering pair notification action key={key} idx={idx}")
                adb_shell(
                    serial,
                    f"content query --uri 'content://com.otacon.kiosk/notifications/action?key={enc_key}&index={idx}'",
                    timeout=5,
                )
                return True
    return False


def _btctl(adapter_mac: str, *commands: str, timeout: int = 15) -> str:
    """Run bluetoothctl commands on a specific adapter."""
    cmds = f'select {adapter_mac}\n' + '\n'.join(commands) + '\n'
    try:
        result = run_cmd(['bluetoothctl'], input=cmds, timeout=timeout)
        return result.stdout or ''
    except Exception as e:
        log.warning(f'bluetoothctl failed: {e}')
        return ''


def enable_discoverable(adapter_mac: str, timeout_seconds: int = 120):
    """Make a specific adapter discoverable and pairable for pairing."""
    _btctl(adapter_mac,
           f'discoverable-timeout {timeout_seconds}',
           'discoverable on',
           'pairable on')
    log.info(f'Adapter {adapter_mac} set Discoverable+Pairable=true '
             f'(timeout={timeout_seconds}s)')


def disable_discoverable(adapter_mac: str):
    """Turn off discoverable and pairable on a specific adapter (idempotent)."""
    _btctl(adapter_mac, 'discoverable off', 'pairable off')
    log.info(f'Adapter {adapter_mac} set Discoverable+Pairable=false')


def _bluez_is_paired(adapter_hci: str, phone_bt_mac: str) -> bool:
    """Read only this adapter's bond, even when another adapter is missing."""
    try:
        import dbus
        bus = dbus.SystemBus()
        path = f'/org/bluez/{adapter_hci}/dev_' + phone_bt_mac.upper().replace(':', '_')
        props = dbus.Interface(bus.get_object('org.bluez', path),
                               'org.freedesktop.DBus.Properties')
        return bool(props.Get('org.bluez.Device1', 'Paired'))
    except Exception:
        return False


def _dbus_discover_and_pair(adapter_hci: str, phone_bt_mac: str,
                            serial: str, discovery_timeout: int = 20,
                            phone_initiated: bool = False,
                            ) -> tuple[bool, bool]:
    """Discover, pair, trust and connect a phone via D-Bus.

    Using D-Bus directly instead of bluetoothctl avoids agent conflicts:
    bluetoothctl registers its own agent on startup which displaces the
    fleet agent's AutoAcceptAgent, causing pair confirmations to be
    silently dropped in non-interactive (piped) mode.

    With phone_initiated, wait for Android's direct createBond request
    instead of scanning or issuing a competing Pair request. The phone
    doesn't have to be discoverable for this path.

    Returns (paired, connected) booleans.
    """
    import dbus

    bus = dbus.SystemBus()
    adapter_path = f'/org/bluez/{adapter_hci}'
    phone_mac_upper = phone_bt_mac.upper()
    device_path = None

    # Discovery
    log.info(f'[{serial}] BlueZ: waiting for phone bond on {adapter_hci}' if phone_initiated
             else f'[{serial}] BlueZ: running discovery on {adapter_hci}')
    adapter = dbus.Interface(
        bus.get_object('org.bluez', adapter_path), 'org.bluez.Adapter1',
    )
    if not phone_initiated:
        try:
            adapter.StartDiscovery()
        except dbus.DBusException as e:
            if e.get_dbus_name() != 'org.bluez.Error.InProgress':
                log.warning(f'[{serial}] D-Bus StartDiscovery error: {e}')
                return False, False
            # Reuse our process's earlier session and always stop it below.
            log.info(f'[{serial}] BlueZ: discovery already running on {adapter_hci}, reusing it')

    try:
        for tick in range(discovery_timeout):
            time.sleep(1)
            mgr = dbus.Interface(
                bus.get_object('org.bluez', '/'),
                'org.freedesktop.DBus.ObjectManager',
            )
            for path, ifaces in mgr.GetManagedObjects().items():
                if 'org.bluez.Device1' not in ifaces:
                    continue
                if f'/{adapter_hci}/' not in path:
                    continue
                addr = str(ifaces['org.bluez.Device1'].get('Address', ''))
                if addr.upper() == phone_mac_upper:
                    if phone_initiated and not ifaces['org.bluez.Device1'].get('Paired', False):
                        continue
                    device_path = path
                    break
            if device_path:
                break
    finally:
        if not phone_initiated:
            try:
                adapter.StopDiscovery()
            except dbus.DBusException:
                pass

    if not device_path:
        log.warning(f'[{serial}] BlueZ: {phone_bt_mac} not '
                    f'{"bonded" if phone_initiated else "found"} after '
                    f'{discovery_timeout}s on {adapter_hci}')
        return False, False

    log.info(f'[{serial}] BlueZ: found {phone_bt_mac} at {device_path}')

    # Pair
    dev = dbus.Interface(
        bus.get_object('org.bluez', device_path), 'org.bluez.Device1',
    )
    props = dbus.Interface(
        bus.get_object('org.bluez', device_path),
        'org.freedesktop.DBus.Properties',
    )

    if not phone_initiated:
        log.info(f'[{serial}] BlueZ: pairing with {phone_bt_mac}')
        try:
            dev.Pair()
        except dbus.DBusException as e:
            err_name = e.get_dbus_name()
            if err_name == 'org.bluez.Error.AlreadyExists':
                log.info(f'[{serial}] BlueZ: already paired')
            else:
                log.warning(f'[{serial}] BlueZ Pair() error: {e}')
                return False, False
        time.sleep(1)

    # Trust
    try:
        props.Set('org.bluez.Device1', 'Trusted', True)
        log.info(f'[{serial}] BlueZ: trusted {phone_bt_mac}')
    except dbus.DBusException as e:
        log.warning(f'[{serial}] BlueZ trust error: {e}')

    # Connect (if not already)
    try:
        is_connected = bool(props.Get('org.bluez.Device1', 'Connected'))
        if not is_connected:
            dev.Connect()
            time.sleep(2)
    except dbus.DBusException as e:
        log.warning(f'[{serial}] BlueZ connect error: {e}')

    # Verify
    try:
        paired = bool(props.Get('org.bluez.Device1', 'Paired'))
        connected = bool(props.Get('org.bluez.Device1', 'Connected'))
    except dbus.DBusException:
        paired, connected = False, False

    return paired, connected


def _run_bluez_pair(adapter_mac: str, adapter_hci: str, serial: str,
                    ready: threading.Event | None = None):
    """Pi-side BlueZ pairing flow (replaces bluetooth-pair.sh).

    Prepare the adapter before Android initiates pairing directly to its
    known MAC, then trust/connect the resulting bond. No phone visibility
    request is needed. Runs alongside the ContentProvider pair request.

    Discoverable is enabled only for this adapter for the duration of
    the pair attempt, and restored to false in a finally block.
    """
    try:
        # Wait for bluetoothd
        for _ in range(30):
            out = _btctl(adapter_mac, 'show')
            if 'Controller' in out:
                break
            time.sleep(1)

        _btctl(adapter_mac, 'power on')
        time.sleep(1)

        # Enable discoverable only on THIS adapter, with safety-net timeout
        enable_discoverable(adapter_mac, timeout_seconds=120)

        try:
            # Get phone BT MAC
            phone_bt_mac = adb_shell(serial, 'settings get secure bluetooth_address').strip()
            if not phone_bt_mac or phone_bt_mac == 'null':
                phone_bt_mac = get_cached_bt_mac(serial)
                if not phone_bt_mac:
                    log.warning(f'[{serial}] BlueZ pair: could not get phone BT MAC')
                    return

            # The caller has cleared the phone-side bond, so clear any old
            # Pi-side key before letting Android create its replacement.
            if _bluez_is_paired(adapter_hci, phone_bt_mac):
                log.info(f'[{serial}] Removing old BlueZ key before phone-initiated pairing')
                _btctl(adapter_mac, f'remove {phone_bt_mac}')
                time.sleep(1)

            if ready is not None:
                ready.set()

            paired, connected = _dbus_discover_and_pair(
                adapter_hci, phone_bt_mac, serial,
                discovery_timeout=35, phone_initiated=True,
            )
            log.info(f'[{serial}] BlueZ pair flow complete: paired={paired} connected={connected}')

        finally:
            disable_discoverable(adapter_mac)

    except Exception as e:
        log.warning(f'[{serial}] BlueZ pair failed: {e}')


def _do_pair_tap_loop(serial: str, snapshot_url: str, label: str = '') -> bool:
    """Poll for pair dialog and auto-tap. Returns True if tapped."""
    ensure_screen_on(serial)
    for i in range(30):
        time.sleep(1)
        if i % 5 == 0:
            ensure_screen_on(serial)
        result = _find_pair_button_with_bounds(snapshot_url)
        if result:
            ref, bounds = result
            # Use `input tap` (real touch) — Pixel system dialogs don't
            # honor a11y performAction(ACTION_CLICK).
            cx = (bounds['x1'] + bounds['x2']) // 2
            cy = (bounds['y1'] + bounds['y2']) // 2
            log.info(f"Auto-tapping 'Pair/Allow' button ({ref}) at ({cx},{cy}){label}")
            adb_shell(serial, f'input tap {cx} {cy}')
            return True
        if _tap_pair_notification(serial):
            return True
    return False


def run_pair_dialog_watcher(serial: str, snapshot_url: str,
                            stop_event: threading.Event,
                            poll_interval: float = 3.0):
    """Background watcher that auto-taps pair dialogs whenever they appear.

    Runs until stop_event is set. Designed to be started as a daemon thread
    from PhoneAgent so pair dialogs are handled regardless of which heal
    (or reconnect churn) triggered them.
    """
    while not stop_event.is_set():
        try:
            result = _find_pair_button_with_bounds(snapshot_url)
            if result:
                ref, bounds = result
                cx = (bounds['x1'] + bounds['x2']) // 2
                cy = (bounds['y1'] + bounds['y2']) // 2
                log.info(f"[{serial}] Pair-dialog watcher: auto-tapping '{ref}' at ({cx},{cy})")
                adb_shell(serial, f'input tap {cx} {cy}')
                # Brief cooldown after tap to let the dialog dismiss
                stop_event.wait(2)
                continue
            if _tap_pair_notification(serial):
                log.info(f'[{serial}] Pair-dialog watcher: tapped notification action')
                stop_event.wait(2)
                continue
        except Exception as e:
            log.debug(f'[{serial}] Pair-dialog watcher error: {e}')
        stop_event.wait(poll_interval)
    log.info(f'[{serial}] Pair-dialog watcher stopped')


def _nuke_phone_bt_bonds(serial: str):
    """Wipe all phone-side BT bonds by clearing the Bluetooth app data.

    On Samsung Android 16+, BluetoothDevice.removeBond() via reflection
    silently fails — the Java API returns true but the native bt_config
    retains the bond keys.  ``pm clear com.android.bluetooth`` is the only
    reliable way to remove bonds on these devices.

    Sequence: disable BT → clear data → re-enable BT.
    """
    log.info(f'[{serial}] Nuking all phone-side BT bonds via pm clear')
    try:
        adb_shell(serial, 'svc bluetooth disable', timeout=5)
        time.sleep(3)
        adb_shell(serial, 'pm clear com.android.bluetooth', timeout=10)
        time.sleep(2)
        adb_shell(serial, 'svc bluetooth enable', timeout=5)
        # Wait for BT stack to fully reinitialize
        for _ in range(10):
            time.sleep(1)
            try:
                out = adb_shell(serial, 'dumpsys bluetooth_manager', timeout=5)
                if 'state: ON' in out:
                    break
            except Exception:
                pass
        log.info(f'[{serial}] Phone BT bonds cleared and BT re-enabled')
    except Exception as e:
        log.warning(f'[{serial}] Failed to nuke phone BT bonds: {e}')


def _clear_phone_bond(serial: str, adapter_mac: str):
    """Remove the assigned bond first; fall back for OEMs where that fails.

    Clearing the Bluetooth app data alone can leave Pixel bond keys intact,
    causing createBond to return already_paired forever on a one-sided bond.
    """
    result = adb_shell(
        serial,
        f"content query --uri 'content://com.otacon.kiosk/bluetooth/unpair?mac={adapter_mac}'",
        timeout=20,
    )
    if 'ok=true' in result:
        log.info(f'[{serial}] Cleared phone bond with {adapter_mac}')
        return
    _nuke_phone_bt_bonds(serial)


def allocate_and_pair_bluetooth(serial: str, snapshot_url: str,
                                 report_error=None, force_repair: bool = False,
                                 ) -> tuple[str | None, str | None, str | None, str | None]:
    """Allocate a BT dongle and pair the phone with it.

    Returns (adapter_mac, adapter_hci, phone_bt_mac, replaced_mac).
    replaced_mac is the old dongle MAC that was saved but missing at startup,
    or None if no reassignment occurred.

    Keep an existing bond on both sides even when disconnected. Connection
    recovery must not wipe valid bonds or ask Android to become discoverable.
    Explicit manual pairing can set force_repair to replace an existing bond.
    """
    if os.environ.get('AUDIO_BACKEND') != 'bluetooth':
        return (None, None, None, None)

    result = allocate_dongle(serial)
    if not result:
        if report_error:
            report_error('bluetooth.no_free_dongle',
                         f'No free BT dongle available for {serial}')
        return (None, None, None, None)
    adapter_mac, adapter_hci, replaced_mac = result

    # Get phone's BT MAC
    phone_bt_mac = adb_shell(serial, 'settings get secure bluetooth_address').strip()
    if not phone_bt_mac or phone_bt_mac == 'null':
        phone_bt_mac = None
    if not phone_bt_mac:
        cached = get_cached_bt_mac(serial)
        if cached:
            phone_bt_mac = cached
            log.info(f'[{serial}] Restored phone_bt_mac from cache: {phone_bt_mac}')
        else:
            try:
                with open(PHONES_JSON_PATH) as f:
                    for p in json.load(f):
                        if p.get('adb_serial') == serial and p.get('phone_bt_mac'):
                            phone_bt_mac = p['phone_bt_mac']
                            log.info(f'[{serial}] Restored phone_bt_mac from phones.json: {phone_bt_mac}')
                            break
            except (FileNotFoundError, json.JSONDecodeError, KeyError):
                pass

    log.info(f'[{serial}] Pairing with dongle {adapter_mac} ({adapter_hci}), phone BT: {phone_bt_mac}')

    # The BlueZ agent accepts a pair on this adapter only from the phone
    # recorded against it in phones.json, so record that before pairing.
    # Recording it only after success deadlocks: a fresh or released
    # assignment has no phone_bt_mac, so the agent rejects the very pair
    # that would have written it.
    if phone_bt_mac:
        save_dongle_assignment(serial, adapter_mac, phone_bt_mac)

    # Clear stale phone-side bonds with OTHER dongles.
    # Also remove Pi-side bonds for the phone on wrong adapters.
    all_dongles = enum_dongles()
    has_wrong_bond = False
    for mac, _hci in all_dongles.items():
        if mac.upper() != adapter_mac.upper() and phone_bt_mac:
            # Check if wrong adapter has a Pi-side bond with this phone
            try:
                if _bluez_is_paired(_hci, phone_bt_mac):
                    log.warning(f'[{serial}] Removing cross-dongle Pi-side bond: '
                                f'{phone_bt_mac} on {mac}')
                    _btctl(mac, f'disconnect {phone_bt_mac}',
                           f'remove {phone_bt_mac}')
                    has_wrong_bond = True
            except Exception:
                pass

    if not force_repair and phone_bt_mac and not has_wrong_bond:
        from ..phone.health import check_bt_bonded
        if check_bt_bonded(adapter_mac, phone_bt_mac, serial=serial).ok:
            log.info(f'[{serial}] Already bonded on {adapter_mac}; keeping the bond')
            return (adapter_mac, adapter_hci, phone_bt_mac, replaced_mac)

    # Use targeted unpair on Pixel; retain the pm-clear fallback for OEMs
    # where removeBond fails. Only replace keys when a new bond is needed.
    _clear_phone_bond(serial, adapter_mac)
    time.sleep(2)

    pair_result = {}
    pair_done = threading.Event()

    def do_pair():
        r = adb_shell(
            serial,
            f"content query --uri 'content://com.otacon.kiosk/bluetooth/pair?mac={adapter_mac}'",
            timeout=45
        )
        log.info(f'[{serial}] Phone-side pair result: {r}')
        pair_result['data'] = r
        pair_done.set()

    ensure_screen_on(serial)

    pair_ready = threading.Event()
    pair_script = threading.Thread(target=_run_bluez_pair,
                                   args=(adapter_mac, adapter_hci, serial, pair_ready), daemon=True)
    pair_script.start()
    if not pair_ready.wait(timeout=45):
        log.warning(f'[{serial}] BlueZ adapter not ready for phone-initiated pairing')
        if report_error:
            report_error('bluetooth.pair_failed', 'BlueZ adapter not ready for pairing')
        return (adapter_mac, adapter_hci, phone_bt_mac, replaced_mac)

    pair_thread = threading.Thread(target=do_pair, daemon=True)
    pair_thread.start()

    _do_pair_tap_loop(serial, snapshot_url)

    pair_thread.join(timeout=45)
    pair_script.join(timeout=30)  # wait for BlueZ pair/trust/connect to finish
    result_data = pair_result.get('data', '')

    # Detect stale one-sided bond
    if 'already_paired' in result_data and phone_bt_mac:
        bluez_check = run_cmd(
            ['bluetoothctl'],
            input=f'select {adapter_mac}\ninfo {phone_bt_mac}\n',
            timeout=10,
        )
        if 'Paired: yes' not in (bluez_check.stdout or ''):
            log.warning(f'[{serial}] Phone reports already_paired but BlueZ has no record -- clearing stale bond and retrying')
            _clear_phone_bond(serial, adapter_mac)
            pair_result.clear()
            pair_done.clear()
            pair_ready.clear()
            retry_script = threading.Thread(target=_run_bluez_pair,
                                            args=(adapter_mac, adapter_hci, serial, pair_ready), daemon=True)
            retry_script.start()
            if not pair_ready.wait(timeout=45):
                log.warning(f'[{serial}] BlueZ adapter not ready for pairing retry')
                return (adapter_mac, adapter_hci, phone_bt_mac, replaced_mac)
            retry_thread = threading.Thread(target=do_pair, daemon=True)
            retry_thread.start()
            _do_pair_tap_loop(serial, snapshot_url, label=' [retry]')
            retry_thread.join(timeout=45)
            retry_script.join(timeout=30)  # wait for BlueZ pair to finish
            result_data = pair_result.get('data', '')

    if 'ok=true' in result_data:
        status = 'paired' if 'paired' in result_data else 'ok'
    elif 'error=' in result_data:
        status = result_data.split('error=')[-1].strip()
    else:
        status = result_data or 'unknown'
    log.info(f'[{serial}] Bluetooth pairing: {status}')

    # Trust and persist
    if phone_bt_mac and 'ok=true' in (pair_result.get('data', '')):
        save_dongle_assignment(serial, adapter_mac, phone_bt_mac)
        # Refresh the agent's MAC allowlist so it knows about this assignment
        try:
            from .agent import reload_allowlist
            reload_allowlist()
        except Exception:
            pass
        try:
            run_cmd(
                ['bluetoothctl'],
                input=f'select {adapter_mac}\ntrust {phone_bt_mac}\n',
                timeout=10,
            )
            log.info(f'[{serial}] Trusted {phone_bt_mac} on {adapter_mac}')
        except Exception:
            pass

        # Re-apply DPM restrictions after successful pair — belt-and-suspenders
        # against any code path that pairs without the kiosk bracket pattern.
        log.info(f'[{serial}] Re-applying restrictions after successful pair')
        apply_restrictions(serial)

    return (adapter_mac, adapter_hci, phone_bt_mac, replaced_mac)
