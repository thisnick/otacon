"""Detect and reset a wedged Bluetooth controller.

Seen on otacon-pi with two dongles (hci3 2026-11-04, hci2 2026-11-07).
After the kernel killed a stalled ACL link, the controller stopped making
new connections. Every phone-side createBond then failed within seconds
(HCI Page Timeout). l2ping from that adapter answered "Operation already
in progress" although the adapter had no connection, and its ACL counters
stopped moving. The same phone answered l2ping from another adapter.
`hciconfig hciN reset` cleared it, and the next pair attempt worked.

The check runs after a failed pair or reconnect. Each phone has its own
dongle, so resetting one that has just failed costs nothing.
"""

import logging
import threading
import time

from ..util.adb import run_cmd

log = logging.getLogger('fleet-agent')

WEDGED_ERROR = 'Operation already in progress'
# Reset an adapter at most this often, whatever the reason.
RESET_COOLDOWN_SECONDS = 600
# Without the wedge signature, reset after this many failures in a row.
RESET_AFTER_FAILURES = 5

_lock = threading.Lock()
_failures: dict[str, int] = {}
_last_reset: dict[str, float] = {}


def _l2ping_wedged(adapter_hci: str, phone_bt_mac: str) -> bool:
    try:
        r = run_cmd(['l2ping', '-i', adapter_hci, '-c', '1', '-t', '3', phone_bt_mac],
                    timeout=10)
    except Exception:
        return False
    if r.returncode == 0:
        return False
    return WEDGED_ERROR in f'{r.stdout or ""}{r.stderr or ""}'


def _has_connection(adapter_hci: str, phone_bt_mac: str) -> bool:
    try:
        r = run_cmd(['hcitool', '-i', adapter_hci, 'con'], timeout=5)
    except Exception:
        return True  # can't tell, so don't call it wedged
    return phone_bt_mac.upper() in (r.stdout or '').upper()


def is_wedged(adapter_hci: str, phone_bt_mac: str) -> bool:
    """Two l2pings 2s apart get EALREADY while the adapter has no link to the phone."""
    for attempt in range(2):
        if attempt:
            time.sleep(2)
        if not _l2ping_wedged(adapter_hci, phone_bt_mac):
            return False
    return not _has_connection(adapter_hci, phone_bt_mac)


def reset_adapter(adapter_hci: str) -> bool:
    try:
        r = run_cmd(['hciconfig', adapter_hci, 'reset'], timeout=15)
    except Exception as e:
        log.warning(f'hciconfig {adapter_hci} reset failed: {e}')
        return False
    if r.returncode != 0:
        log.warning(f'hciconfig {adapter_hci} reset failed: {(r.stderr or "").strip()}')
        return False
    return True


def note_link_ok(adapter_mac: str):
    with _lock:
        _failures.pop(adapter_mac.upper(), None)


def recover_if_wedged(adapter_mac: str, adapter_hci: str | None,
                      phone_bt_mac: str | None, serial: str,
                      report_error=None, after: str = 'pair') -> bool:
    """Call after a failed pair or reconnect. Returns True if the adapter was reset.

    Resets at once on the wedge signature, or after RESET_AFTER_FAILURES
    failures in a row on this adapter, at most once per
    RESET_COOLDOWN_SECONDS.
    """
    if not adapter_mac or not adapter_hci:
        return False
    key = adapter_mac.upper()
    with _lock:
        failures = _failures.get(key, 0) + 1
        _failures[key] = failures
        last = _last_reset.get(key)
    if last is not None and time.monotonic() - last < RESET_COOLDOWN_SECONDS:
        return False

    if phone_bt_mac and is_wedged(adapter_hci, phone_bt_mac):
        reason = f'l2ping says "{WEDGED_ERROR}" with no connection'
    elif failures >= RESET_AFTER_FAILURES:
        reason = f'{failures} failures in a row'
    else:
        return False

    log.warning(f'[{serial}] Controller {adapter_hci} ({adapter_mac}) looks wedged '
                f'({reason}); resetting it')
    ok = reset_adapter(adapter_hci)
    with _lock:
        _last_reset[key] = time.monotonic()
        if ok:
            _failures[key] = 0
    if report_error:
        report_error('bluetooth.adapter_reset',
                     f'Reset {adapter_hci} ({adapter_mac}) after a failed {after}: {reason}'
                     + ('' if ok else ' (reset failed)'),
                     {'adapter_mac': adapter_mac, 'adapter_hci': adapter_hci,
                      'reason': reason, 'reset_ok': ok})
    return ok
