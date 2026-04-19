import json
import logging
import os
import re
import threading

PHONES_JSON_PATH = os.environ.get('PHONES_CONFIG', '/data/otacon/phones.json')

log = logging.getLogger('fleet-agent')

# Reject test/fake serials as defense in depth (feedback_test_cleanup.md)
_REJECT_SERIAL_RE = re.compile(r'^(TEST|FAKE|PHANTOM|.*ABC)$', re.IGNORECASE)


class PortAllocator:
    """Allocates unique ports per phone serial, persisted in phones.json.

    Same serial -> same ports across restarts, so ADB forwards, snapshot URLs,
    and VNC ports stay deterministic. New serials get the next free index.
    """

    def __init__(self, snapshot_start: int = 9091, internal_start: int = 8081,
                 display_start: int = 50, vnc_start: int = 5900):
        self._snapshot_start = snapshot_start
        self._internal_start = internal_start
        self._display_start = display_start
        self._vnc_start = vnc_start
        self._lock = threading.Lock()

    def _idx_from_ports(self, snapshot_port: int) -> int:
        return snapshot_port - self._snapshot_start

    def _load_assignments(self) -> dict[str, int]:
        """Read phones.json -> {serial: idx}. Returns empty dict on error."""
        try:
            with open(PHONES_JSON_PATH) as f:
                phones = json.load(f)
            out = {}
            for p in phones:
                serial = p.get('adb_serial')
                sp = p.get('snapshot_port')
                if serial and sp:
                    out[serial] = self._idx_from_ports(sp)
            return out
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _save_assignment(self, serial: str, idx: int):
        """Persist port assignment to phones.json."""
        snapshot_port = self._snapshot_start + idx
        internal_port = self._internal_start + idx
        display_num = self._display_start + idx
        vnc_port = self._vnc_start + idx
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
                    p['snapshot_port'] = snapshot_port
                    p['internal_port'] = internal_port
                    p['display_num'] = display_num
                    p['vnc_port'] = vnc_port
                    found = True
                    break
            if not found:
                phones.append({
                    'adb_serial': serial,
                    'snapshot_port': snapshot_port,
                    'internal_port': internal_port,
                    'display_num': display_num,
                    'vnc_port': vnc_port,
                })
            os.makedirs(os.path.dirname(PHONES_JSON_PATH), exist_ok=True)
            with open(PHONES_JSON_PATH, 'w') as f:
                json.dump(phones, f, indent=2)
        except OSError as e:
            log.warning(f'Failed to persist port assignment for {serial}: {e}')

    @staticmethod
    def _validate_serial(serial: str) -> None:
        """Reject empty or test-pattern serials (defense in depth)."""
        if not serial:
            raise ValueError('Cannot register phone with empty serial')
        if _REJECT_SERIAL_RE.match(serial):
            raise ValueError(
                f'Rejected test/fake serial: {serial!r} '
                f'(matches reject pattern)')

    def allocate(self, serial: str) -> tuple[int, int, int, int]:
        """Allocate ports for a serial. Reuses saved assignment if present."""
        self._validate_serial(serial)
        with self._lock:
            assignments = self._load_assignments()
            if serial in assignments:
                idx = assignments[serial]
                log.info(f'Reusing saved ports for {serial}: idx={idx}')
            else:
                used = set(assignments.values())
                idx = 0
                while idx in used:
                    idx += 1
                log.info(f'Assigning new ports for {serial}: idx={idx}')
            self._save_assignment(serial, idx)
            return (
                self._snapshot_start + idx,
                self._internal_start + idx,
                self._display_start + idx,
                self._vnc_start + idx,
            )

    def release(self, snapshot_port: int):
        pass

    def release_dongle(self, adapter_mac: str) -> None:
        """Clear dongle assignment, returning it to the spare pool.

        Sets adapter_mac to None for the phone entry in phones.json that
        was using this dongle. Does NOT delete the dongle or phone entry.
        """
        with self._lock:
            try:
                phones = []
                try:
                    with open(PHONES_JSON_PATH) as f:
                        phones = json.load(f)
                except (FileNotFoundError, json.JSONDecodeError):
                    return
                changed = False
                for p in phones:
                    if (p.get('adapter_mac') or '').upper() == adapter_mac.upper():
                        p['adapter_mac'] = None
                        p['phone_bt_mac'] = None
                        changed = True
                        break
                if changed:
                    with open(PHONES_JSON_PATH, 'w') as f:
                        json.dump(phones, f, indent=2)
                    log.info(f'Released dongle {adapter_mac} back to spare pool')
            except OSError as e:
                log.warning(f'Failed to release dongle {adapter_mac}: {e}')

    def claim_spare_dongle(self, serial: str, _enum_dongles=None) -> str | None:
        """Claim a free spare dongle for the given phone serial.

        Looks at phones.json to find adapter_macs that are currently assigned,
        then enumerates live dongles and returns the first one that is NOT
        assigned to any phone. Returns None if no spare is available.
        """
        if _enum_dongles is None:
            from ..bluetooth.dongle import enum_dongles
            _enum_dongles = enum_dongles

        with self._lock:
            try:
                phones = []
                try:
                    with open(PHONES_JSON_PATH) as f:
                        phones = json.load(f)
                except (FileNotFoundError, json.JSONDecodeError):
                    pass

                # Collect all currently assigned MACs (excluding the requesting phone)
                assigned_macs = set()
                for p in phones:
                    mac = p.get('adapter_mac')
                    if mac and (p.get('adb_serial') or '') != serial:
                        assigned_macs.add(mac.upper())

                # Enumerate live dongles
                live_dongles = _enum_dongles()
                for mac in live_dongles:
                    if mac.upper() not in assigned_macs:
                        log.info(f'Claiming spare dongle {mac} for phone {serial}')
                        return mac.upper()

                return None
            except Exception as e:
                log.error(f'Error claiming spare dongle: {e}')
                return None
