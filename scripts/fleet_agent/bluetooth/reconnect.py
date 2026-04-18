"""Event-driven Bluetooth reconnect — replaces bt-reconnect.py.

Watches org.bluez.Device1 PropertiesChanged signals via D-Bus.
When a paired device disconnects, reconnects with exponential backoff.
Uses ConnectProfile(A2DP_SOURCE_UUID) to force BR/EDR.
"""

import logging
import dbus
import dbus.mainloop.glib
from gi.repository import GLib

log = logging.getLogger('fleet-agent')

INITIAL_DELAY_MS   = 3000
MAX_DELAY_MS       = 60000
STARTUP_DELAY_MS   = 2000
INPROGRESS_WAIT_MS = 30000

A2DP_SOURCE_UUID = '0000110a-0000-1000-8000-00805f9b34fb'

_connecting = set()


def _is_connected(bus, path):
    try:
        props = dbus.Interface(
            bus.get_object('org.bluez', path),
            'org.freedesktop.DBus.Properties',
        )
        return bool(props.Get('org.bluez.Device1', 'Connected'))
    except dbus.exceptions.DBusException:
        return False


def _attempt_connect(bus, path, delay_ms):
    """Async Connect(); on failure reschedule with doubled delay."""
    if _is_connected(bus, path):
        log.info(f'{path}: connected')
        _connecting.discard(path)
        return

    if path in _connecting:
        log.info(f'{path}: connect in progress, waiting {INPROGRESS_WAIT_MS // 1000}s')
        GLib.timeout_add(INPROGRESS_WAIT_MS, _attempt_connect, bus, path, delay_ms)
        return

    log.info(f'{path}: connecting (BR/EDR)...')
    _connecting.add(path)
    dev = dbus.Interface(bus.get_object('org.bluez', path), 'org.bluez.Device1')

    def on_success():
        _connecting.discard(path)
        log.info(f'{path}: connected')

    def on_error(e):
        _connecting.discard(path)
        name = e.get_dbus_name()
        if name == 'org.bluez.Error.InProgress':
            wait = INPROGRESS_WAIT_MS
            log.info(f'{path}: connect already in progress, retry in {wait // 1000}s')
        else:
            wait = min(delay_ms * 2, MAX_DELAY_MS)
            log.warning(f'{path}: connect failed ({name}), retry in {wait // 1000}s')
        GLib.timeout_add(wait, _attempt_connect, bus, path, wait)

    dev.ConnectProfile(A2DP_SOURCE_UUID, reply_handler=on_success, error_handler=on_error)


def _schedule_reconnect(bus, path, delay_ms=INITIAL_DELAY_MS):
    log.info(f'{path}: reconnect scheduled in {delay_ms // 1000}s')
    GLib.timeout_add(delay_ms, _attempt_connect, bus, path, delay_ms)
    return False


def _watch_device(bus, path):
    """Register PropertiesChanged listener for a paired device."""
    def on_props_changed(interface, changed, _invalidated):
        if interface != 'org.bluez.Device1':
            return
        if 'Connected' in changed:
            connected = bool(changed['Connected'])
            log.info(f'{path}: Connected -> {connected}')
            if not connected:
                _connecting.discard(path)
                _schedule_reconnect(bus, path)

    bus.add_signal_receiver(
        on_props_changed,
        dbus_interface='org.freedesktop.DBus.Properties',
        signal_name='PropertiesChanged',
        path=path,
    )
    log.info(f'{path}: watching for disconnects')


def setup_reconnect_watcher(bus=None):
    """Set up D-Bus watchers for paired device disconnects.

    If bus is None, creates a new SystemBus (requires GLib mainloop).
    """
    if bus is None:
        bus = dbus.SystemBus()

    mgr = dbus.Interface(
        bus.get_object('org.bluez', '/'),
        'org.freedesktop.DBus.ObjectManager',
    )

    objects = mgr.GetManagedObjects()
    paired = [
        path for path, ifaces in objects.items()
        if 'org.bluez.Device1' in ifaces
        and ifaces['org.bluez.Device1'].get('Paired', False)
    ]

    for path in paired:
        _watch_device(bus, path)
        if not _is_connected(bus, path):
            _schedule_reconnect(bus, path, STARTUP_DELAY_MS)

    if not paired:
        log.info('No paired devices found -- will watch for new pairings')

    def on_interfaces_added(path, ifaces):
        if 'org.bluez.Device1' not in ifaces:
            return
        if not ifaces['org.bluez.Device1'].get('Paired', False):
            return
        log.info(f'{path}: new paired device appeared')
        _watch_device(bus, path)
        _schedule_reconnect(bus, path, STARTUP_DELAY_MS)

    bus.add_signal_receiver(
        on_interfaces_added,
        dbus_interface='org.freedesktop.DBus.ObjectManager',
        signal_name='InterfacesAdded',
    )

    log.info(f'Watching {len(paired)} paired device(s)')
