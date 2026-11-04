"""Event-driven Bluetooth reconnect — replaces bt-reconnect.py.

Watches org.bluez.Device1 PropertiesChanged signals via D-Bus.
When a paired device disconnects, reconnects with exponential backoff.
Uses ConnectProfile(A2DP_SOURCE_UUID) to force BR/EDR.

Each device has at most one scheduled attempt and one Connect call in
flight. Retries stop once BlueZ no longer has the device or it is no longer
paired; the InterfacesAdded watcher picks it up again when it is re-paired.
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

# D-Bus errors that mean the device object is gone (removed or unpaired by
# the pair flow), so retrying can never succeed.
GONE_ERRORS = {
    'org.freedesktop.DBus.Error.UnknownObject',
    'org.bluez.Error.DoesNotExist',
}

_connecting = set()   # paths with a ConnectProfile call in flight
_pending = {}         # path -> GLib source id of its one scheduled attempt
_watched = set()      # paths with a PropertiesChanged receiver


def _device_props(bus, path):
    """Device1 properties; None if the device is gone, {} on other errors."""
    try:
        props = dbus.Interface(
            bus.get_object('org.bluez', path),
            'org.freedesktop.DBus.Properties',
        )
        return props.GetAll('org.bluez.Device1')
    except dbus.exceptions.DBusException as e:
        if e.get_dbus_name() in GONE_ERRORS:
            return None
        return {}


def _cancel(path):
    source = _pending.pop(path, None)
    if source is not None:
        GLib.source_remove(source)


def _attempt_connect(bus, path, delay_ms):
    """Async Connect(); on failure reschedule with doubled delay."""
    _pending.pop(path, None)  # this attempt was the scheduled one

    props = _device_props(bus, path)
    if props is None or (props and not props.get('Paired', False)):
        log.info(f'{path}: no longer paired, stopping reconnect')
        return False
    if props.get('Connected', False):
        log.info(f'{path}: connected')
        return False

    if path in _connecting:
        # The call in flight reschedules if it fails.
        log.info(f'{path}: connect already in flight')
        return False

    log.info(f'{path}: connecting (BR/EDR)...')
    _connecting.add(path)

    def on_success():
        _connecting.discard(path)
        log.info(f'{path}: connected')

    def on_error(e):
        _connecting.discard(path)
        name = e.get_dbus_name()
        if name in GONE_ERRORS:
            log.info(f'{path}: device gone ({name}), stopping reconnect')
            return
        if name == 'org.bluez.Error.InProgress':
            wait = INPROGRESS_WAIT_MS
            log.info(f'{path}: connect already in progress, retry in {wait // 1000}s')
        else:
            wait = min(delay_ms * 2, MAX_DELAY_MS)
            log.warning(f'{path}: connect failed ({name}), retry in {wait // 1000}s')
        _schedule_reconnect(bus, path, wait)

    try:
        dev = dbus.Interface(bus.get_object('org.bluez', path), 'org.bluez.Device1')
        dev.ConnectProfile(A2DP_SOURCE_UUID, reply_handler=on_success, error_handler=on_error)
    except dbus.exceptions.DBusException as e:
        on_error(e)
    return False


def _schedule_reconnect(bus, path, delay_ms=INITIAL_DELAY_MS):
    """Schedule the device's next attempt, replacing any already scheduled."""
    _cancel(path)
    log.info(f'{path}: reconnect scheduled in {delay_ms // 1000}s')
    _pending[path] = GLib.timeout_add(delay_ms, _attempt_connect, bus, path, delay_ms)
    return False


def _watch_device(bus, path):
    """Register PropertiesChanged listener for a paired device (once per path)."""
    if path in _watched:
        return
    _watched.add(path)

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
        if not objects[path]['org.bluez.Device1'].get('Connected', False):
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

    def on_interfaces_removed(path, ifaces):
        if 'org.bluez.Device1' not in ifaces:
            return
        if path in _pending or path in _connecting:
            log.info(f'{path}: device removed, stopping reconnect')
        _cancel(path)
        _connecting.discard(path)

    bus.add_signal_receiver(
        on_interfaces_added,
        dbus_interface='org.freedesktop.DBus.ObjectManager',
        signal_name='InterfacesAdded',
    )
    bus.add_signal_receiver(
        on_interfaces_removed,
        dbus_interface='org.freedesktop.DBus.ObjectManager',
        signal_name='InterfacesRemoved',
    )

    log.info(f'Watching {len(paired)} paired device(s)')
