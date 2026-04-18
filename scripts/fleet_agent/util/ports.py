import json
import logging
import os
import threading

PHONES_JSON_PATH = os.environ.get('PHONES_CONFIG', '/data/otacon/phones.json')

log = logging.getLogger('fleet-agent')


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

    def allocate(self, serial: str) -> tuple[int, int, int, int]:
        """Allocate ports for a serial. Reuses saved assignment if present."""
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
