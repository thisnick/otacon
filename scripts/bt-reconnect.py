#!/usr/bin/env python3
"""
bt-reconnect.py — Event-driven Bluetooth reconnect daemon.

Watches org.bluez.Device1 PropertiesChanged signals via D-Bus.
When a paired device disconnects, reconnects with exponential backoff.
Also connects any paired-but-disconnected devices on startup.
"""
import dbus
import dbus.mainloop.glib
from gi.repository import GLib
import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s bt-reconnect: %(message)s',
    datefmt='%H:%M:%S',
    stream=sys.stdout,
)
log = logging.getLogger('bt-reconnect')

INITIAL_DELAY_MS  = 3000   # first reconnect attempt after disconnect
MAX_DELAY_MS      = 60000  # cap backoff at 60s
STARTUP_DELAY_MS  = 2000   # delay before first connect attempt at startup


def get_device_props(bus, path):
    return dbus.Interface(
        bus.get_object('org.bluez', path),
        'org.freedesktop.DBus.Properties',
    )


def is_connected(bus, path):
    try:
        return bool(get_device_props(bus, path).Get('org.bluez.Device1', 'Connected'))
    except dbus.exceptions.DBusException:
        return False


def attempt_connect(bus, path, delay_ms):
    """Try to connect; if it fails, reschedule with doubled delay."""
    if is_connected(bus, path):
        log.info(f'{path}: already connected, done')
        return

    log.info(f'{path}: connecting...')
    try:
        dev = dbus.Interface(bus.get_object('org.bluez', path), 'org.bluez.Device1')
        dev.Connect()
        log.info(f'{path}: connected')
    except dbus.exceptions.DBusException as e:
        next_delay = min(delay_ms * 2, MAX_DELAY_MS)
        log.warning(f'{path}: connect failed ({e.get_dbus_name()}), retry in {next_delay // 1000}s')
        GLib.timeout_add(next_delay, attempt_connect, bus, path, next_delay)


def schedule_reconnect(bus, path, delay_ms=INITIAL_DELAY_MS):
    log.info(f'{path}: scheduling reconnect in {delay_ms // 1000}s')
    GLib.timeout_add(delay_ms, attempt_connect, bus, path, delay_ms)
    return False  # don't repeat the caller's timeout


def watch_device(bus, path):
    """Register PropertiesChanged listener for a paired device."""
    def on_props_changed(interface, changed, _invalidated):
        if interface != 'org.bluez.Device1':
            return
        if 'Connected' in changed:
            connected = bool(changed['Connected'])
            log.info(f'{path}: Connected → {connected}')
            if not connected:
                schedule_reconnect(bus, path)

    bus.add_signal_receiver(
        on_props_changed,
        dbus_interface='org.freedesktop.DBus.Properties',
        signal_name='PropertiesChanged',
        path=path,
    )
    log.info(f'{path}: watching for disconnects')


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()

    mgr = dbus.Interface(
        bus.get_object('org.bluez', '/'),
        'org.freedesktop.DBus.ObjectManager',
    )

    # Watch all currently-paired devices
    objects = mgr.GetManagedObjects()
    paired = [
        path for path, ifaces in objects.items()
        if 'org.bluez.Device1' in ifaces
        and ifaces['org.bluez.Device1'].get('Paired', False)
    ]

    for path in paired:
        watch_device(bus, path)
        if not is_connected(bus, path):
            schedule_reconnect(bus, path, STARTUP_DELAY_MS)

    if not paired:
        log.info('No paired devices found — will watch for new pairings')

    # Also pick up devices paired while we're running
    def on_interfaces_added(path, ifaces):
        if 'org.bluez.Device1' not in ifaces:
            return
        if not ifaces['org.bluez.Device1'].get('Paired', False):
            return
        log.info(f'{path}: new paired device appeared')
        watch_device(bus, path)
        schedule_reconnect(bus, path, STARTUP_DELAY_MS)

    bus.add_signal_receiver(
        on_interfaces_added,
        dbus_interface='org.freedesktop.DBus.ObjectManager',
        signal_name='InterfacesAdded',
    )

    log.info(f'Watching {len(paired)} paired device(s)')
    GLib.MainLoop().run()


if __name__ == '__main__':
    main()
