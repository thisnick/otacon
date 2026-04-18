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
from ..steps.screen import ensure_screen_on

log = logging.getLogger('fleet-agent')

PHONES_JSON_PATH = os.environ.get('PHONES_CONFIG', '/data/otacon/phones.json')


def find_pair_button_in_tree(data) -> str | None:
    """Walk a snapshot a11y tree and find a clickable Pair/Allow button.

    Pure function — takes parsed JSON data, returns ref_id or None.
    """
    if not data:
        return None

    PAIR_TEXTS = {'pair', 'allow'}

    def walk(node):
        text = (node.get('text') or '').strip().lower()
        if text in PAIR_TEXTS and node.get('clickable'):
            return node.get('ref_id')
        for child in node.get('children', []):
            ref = walk(child)
            if ref:
                return ref
        return None

    nodes = data if isinstance(data, list) else [data]
    for node in nodes:
        ref = walk(node)
        if ref:
            return ref
    return None


def _find_pair_button(snapshot_url: str) -> str | None:
    data = http_get(f'{snapshot_url}/snapshot?format=json', timeout=3)
    return find_pair_button_in_tree(data)


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


def _run_bluez_pair(adapter_mac: str, adapter_hci: str, serial: str):
    """Pi-side BlueZ pairing flow (replaces bluetooth-pair.sh).

    Powers on the adapter, runs discovery to populate the BlueZ device
    cache, then pairs/trusts/connects.  Runs in a thread alongside the
    phone-side ContentProvider pair request.
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
        _btctl(adapter_mac, 'discoverable on')

        # Enable BT on phone via ADB
        adb_shell(serial, 'cmd bluetooth_manager enable', timeout=5)
        time.sleep(2)

        # Get phone BT MAC
        phone_bt_mac = adb_shell(serial, 'settings get secure bluetooth_address').strip()
        if not phone_bt_mac or phone_bt_mac == 'null':
            log.warning(f'[{serial}] BlueZ pair: could not get phone BT MAC')
            return

        # Check if already paired — test connection
        info_out = _btctl(adapter_mac, f'info {phone_bt_mac}')
        if 'Paired: yes' in info_out:
            log.info(f'[{serial}] Already paired in BlueZ — testing connection')
            _btctl(adapter_mac, f'trust {phone_bt_mac}')
            connect_out = _btctl(adapter_mac, f'connect {phone_bt_mac}')
            if 'successful' in connect_out.lower() or 'already connected' in connect_out.lower():
                _btctl(adapter_mac, 'discoverable off')
                log.info(f'[{serial}] BlueZ: connected (already paired)')
                return
            else:
                log.warning(f'[{serial}] Stale BlueZ bond — removing and re-pairing')
                _btctl(adapter_mac, f'remove {phone_bt_mac}')
                time.sleep(1)

        # Open BT settings on phone (makes it discoverable)
        adb_shell(serial, 'am start -a android.settings.BLUETOOTH_SETTINGS', timeout=5)
        time.sleep(3)

        # D-Bus discovery to populate BlueZ device cache
        adapter_path = f'/org/bluez/{adapter_hci}'
        log.info(f'[{serial}] BlueZ: running discovery on {adapter_hci}')
        try:
            run_cmd(
                ['python3', '-c',
                 'import dbus,sys,time\n'
                 'bus=dbus.SystemBus()\n'
                 f'a=dbus.Interface(bus.get_object("org.bluez","{adapter_path}"),"org.bluez.Adapter1")\n'
                 'a.StartDiscovery()\n'
                 'for _ in range(15):\n'
                 ' time.sleep(1)\n'
                 ' m=dbus.Interface(bus.get_object("org.bluez","/"),"org.freedesktop.DBus.ObjectManager")\n'
                 ' for p,i in m.GetManagedObjects().items():\n'
                 '  if "org.bluez.Device1" in i:\n'
                 f'   if str(i["org.bluez.Device1"].get("Address","")).upper()=="{phone_bt_mac.upper()}":\n'
                 '    a.StopDiscovery();sys.exit(0)\n'
                 'a.StopDiscovery()\n'],
                timeout=20,
            )
        except Exception as e:
            log.warning(f'[{serial}] D-Bus discovery error: {e}')

        # Pair, trust, connect
        log.info(f'[{serial}] BlueZ: pairing with {phone_bt_mac}')
        pair_out = _btctl(adapter_mac, f'pair {phone_bt_mac}', timeout=30)
        log.info(f'[{serial}] BlueZ pair result: {pair_out.strip()[-200:]}')
        time.sleep(1)
        trust_out = _btctl(adapter_mac, f'trust {phone_bt_mac}')
        log.info(f'[{serial}] BlueZ trust result: {trust_out.strip()[-200:]}')
        time.sleep(1)
        connect_out = _btctl(adapter_mac, f'connect {phone_bt_mac}')
        log.info(f'[{serial}] BlueZ connect result: {connect_out.strip()[-200:]}')
        _btctl(adapter_mac, 'discoverable off')

        # Verify bond actually formed
        info_out = _btctl(adapter_mac, f'info {phone_bt_mac}')
        paired = 'Paired: yes' in info_out
        connected = 'Connected: yes' in info_out
        log.info(f'[{serial}] BlueZ pair flow complete: paired={paired} connected={connected}')

    except Exception as e:
        log.warning(f'[{serial}] BlueZ pair failed: {e}')


def _do_pair_tap_loop(serial: str, snapshot_url: str, label: str = '') -> bool:
    """Poll for pair dialog and auto-tap. Returns True if tapped."""
    ensure_screen_on(serial)
    for i in range(30):
        time.sleep(1)
        if i % 5 == 0:
            ensure_screen_on(serial)
        ref = _find_pair_button(snapshot_url)
        if ref:
            log.info(f"Auto-tapping 'Pair' button ({ref}){label}")
            http_post(f'{snapshot_url}/action', {'action': 'click', 'ref': ref})
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
            ref = _find_pair_button(snapshot_url)
            if ref:
                log.info(f"[{serial}] Pair-dialog watcher: auto-tapping '{ref}'")
                http_post(f'{snapshot_url}/action', {'action': 'click', 'ref': ref})
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


def allocate_and_pair_bluetooth(serial: str, snapshot_url: str,
                                 report_error=None) -> tuple[str | None, str | None, str | None]:
    """Allocate a BT dongle and pair the phone with it.

    Returns (adapter_mac, adapter_hci, phone_bt_mac).
    """
    if os.environ.get('AUDIO_BACKEND') != 'bluetooth':
        return (None, None, None)

    result = allocate_dongle(serial)
    if not result:
        if report_error:
            report_error('bluetooth.no_free_dongle',
                         f'No free BT dongle available for {serial}')
        return (None, None, None)
    adapter_mac, adapter_hci = result

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

    # Clear stale phone-side bonds with OTHER dongles
    all_dongles = enum_dongles()
    for mac, _hci in all_dongles.items():
        if mac.upper() != adapter_mac.upper():
            log.info(f'[{serial}] Clearing stale phone-side bond with {mac}')
            adb_shell(
                serial,
                f"content query --uri 'content://com.otacon.kiosk/bluetooth/unpair?mac={mac}'",
                timeout=10
            )

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

    pair_script = threading.Thread(target=_run_bluez_pair, args=(adapter_mac, adapter_hci, serial), daemon=True)
    pair_script.start()

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
            log.warning(f'[{serial}] Phone reports already_paired but BlueZ has no record -- forcing unpair and retrying')
            adb_shell(
                serial,
                f"content query --uri 'content://com.otacon.kiosk/bluetooth/unpair?mac={adapter_mac}'",
                timeout=10
            )
            time.sleep(2)
            pair_result.clear()
            pair_done.clear()
            retry_script = threading.Thread(target=_run_bluez_pair, args=(adapter_mac, adapter_hci, serial), daemon=True)
            retry_script.start()
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
        try:
            run_cmd(
                ['bluetoothctl'],
                input=f'select {adapter_mac}\ntrust {phone_bt_mac}\n',
                timeout=10,
            )
            log.info(f'[{serial}] Trusted {phone_bt_mac} on {adapter_mac}')
        except Exception:
            pass

    return (adapter_mac, adapter_hci, phone_bt_mac)
