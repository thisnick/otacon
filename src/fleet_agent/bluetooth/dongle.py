"""BT dongle enumeration and allocation."""

import json
import logging
import os
import threading
import time

from ..util.adb import run_cmd
from ..util.ports import PHONES_JSON_PATH

log = logging.getLogger('fleet-agent')

_dongle_lock = threading.Lock()
_dongle_cache: dict[str, str] | None = None
_bt_mac_cache: dict[str, str] = {}


def _seed_cache():
    """Populate _dongle_cache from phones.json if not yet loaded."""
    global _dongle_cache
    if _dongle_cache is not None:
        return
    _dongle_cache = {}
    try:
        with open(PHONES_JSON_PATH) as f:
            phones = json.load(f)
        for p in phones:
            s = p.get('adb_serial')
            mac = p.get('adapter_mac')
            if s and mac:
                _dongle_cache[s] = mac.upper()
            btm = p.get('phone_bt_mac')
            if s and btm:
                _bt_mac_cache[s] = btm
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        pass


def parse_hciconfig(output: str) -> dict[str, str]:
    """Parse hciconfig output into {bt_mac: hci_name}.

    Only includes adapters that are UP. DOWN adapters are excluded so
    the loss sweep can detect when an adapter has been powered off.
    Pure function for testing.
    """
    dongles = {}
    current_hci = None
    current_mac = None
    is_up = False
    for raw_line in output.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            # Block boundary — flush current adapter
            if current_hci and current_mac and is_up:
                dongles[current_mac] = current_hci
            current_hci = None
            current_mac = None
            is_up = False
            continue
        if raw_line and not raw_line[0].isspace() and ':' in stripped:
            # New adapter header — flush previous if any
            if current_hci and current_mac and is_up:
                dongles[current_mac] = current_hci
            current_hci = stripped.split(':')[0]
            current_mac = None
            is_up = False
        elif 'BD Address:' in stripped and current_hci:
            mac = stripped.split('BD Address:')[1].strip().split()[0]
            if mac and mac != '00:00:00:00:00:00':
                current_mac = mac.upper()
        elif stripped and current_hci and current_mac is not None:
            # Flags line (e.g., "UP RUNNING PSCAN ISCAN" or "DOWN")
            if 'UP' in stripped.split():
                is_up = True

    # Flush last adapter (no trailing blank line)
    if current_hci and current_mac and is_up:
        dongles[current_mac] = current_hci
    return dongles


def enum_dongles() -> dict[str, str]:
    """Enumerate all HCI adapters. Returns {bt_mac: hci_name}."""
    try:
        result = run_cmd(['hciconfig'], timeout=5)
        return parse_hciconfig(result.stdout)
    except (Exception,):
        return {}


def save_dongle_assignment(serial: str, adapter_mac: str, phone_bt_mac: str | None = None):
    """Update the in-memory cache and best-effort persist to phones.json."""
    if _dongle_cache is not None:
        _dongle_cache[serial] = adapter_mac.upper()
    if phone_bt_mac:
        _bt_mac_cache[serial] = phone_bt_mac

    try:
        phones = []
        try:
            with open(PHONES_JSON_PATH) as f:
                phones = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            pass

        found = False
        for p in phones:
            if p.get('adb_serial') == serial:
                p['adapter_mac'] = adapter_mac
                if phone_bt_mac:
                    p['phone_bt_mac'] = phone_bt_mac
                found = True
                break
        if not found:
            entry = {'adb_serial': serial, 'adapter_mac': adapter_mac}
            if phone_bt_mac:
                entry['phone_bt_mac'] = phone_bt_mac
            phones.append(entry)

        os.makedirs(os.path.dirname(PHONES_JSON_PATH), exist_ok=True)
        with open(PHONES_JSON_PATH, 'w') as f:
            json.dump(phones, f, indent=2)
    except OSError as e:
        log.warning(f'Could not persist dongle assignment: {e}')


def load_dongle_assignments() -> dict[str, str]:
    """Return a {serial: adapter_mac} mapping from the in-memory cache."""
    with _dongle_lock:
        _seed_cache()
        return dict(_dongle_cache)  # type: ignore[arg-type]


def get_cached_bt_mac(serial: str) -> str | None:
    """Return cached phone_bt_mac for a serial, or None."""
    return _bt_mac_cache.get(serial)


def allocate_dongle(serial: str) -> tuple[str, str, str | None] | None:
    """Allocate a BT dongle for a phone.

    Returns (adapter_mac, hci_name, replaced_mac) or None.
    replaced_mac is the old dongle MAC that was saved but no longer present
    (startup reassignment), or None if no reassignment occurred.
    """
    dongles = {}
    for attempt in range(10):
        dongles = enum_dongles()
        if dongles:
            break
        if attempt < 9:
            log.info(f'No BT dongles found yet, retrying in 3s ({attempt + 1}/10)...')
            time.sleep(3)
    if not dongles:
        log.warning('No BT dongles found after 10 attempts')
        return None

    with _dongle_lock:
        _seed_cache()
        used_macs = {mac for s, mac in _dongle_cache.items() if s != serial}

        saved_mac = _dongle_cache.get(serial)
        if saved_mac and saved_mac.upper() in dongles:
            hci = dongles[saved_mac.upper()]
            log.info(f'Reusing saved dongle {saved_mac} ({hci}) for {serial}')
            return (saved_mac.upper(), hci, None)

        replaced_mac = None
        if saved_mac:
            log.warning(f'Saved dongle {saved_mac} not present, reassigning...')
            replaced_mac = saved_mac.upper()

        for mac, hci in dongles.items():
            if mac not in used_macs:
                log.info(f'Assigning free dongle {mac} ({hci}) to {serial}')
                _dongle_cache[serial] = mac
                save_dongle_assignment(serial, mac)
                return (mac, hci, replaced_mac)

        log.error(f'No free BT dongle for {serial}')
        return None
