"""Unit tests for the BlueZ reconnect watcher (bluetooth/reconnect.py).

Seen on otacon-pi 2026-11-04: a phone whose pairing kept failing had ~30
reconnect chains running against one device. Every re-pair added another
PropertiesChanged receiver and another timer chain, chains never merged
("in progress" rescheduled itself), and chains retried forever after the
pair flow removed the device (UnknownObject). The ConnectProfile storm then
hit the device during every new pair attempt.
"""

import sys
import types
from unittest.mock import patch

import pytest

PATH = '/org/bluez/hci3/dev_F0_5C_77_E2_ED_5B'
UNKNOWN_OBJECT = 'org.freedesktop.DBus.Error.UnknownObject'
FAILED = 'org.bluez.Error.Failed'


def _import_reconnect():
    """Import reconnect with stub dbus/gi modules when they aren't installed."""
    stubs = {}
    try:
        import dbus.mainloop.glib  # noqa: F401
    except ImportError:
        dbus = types.ModuleType('dbus')
        dbus.mainloop = types.ModuleType('dbus.mainloop')
        dbus.mainloop.glib = types.ModuleType('dbus.mainloop.glib')
        stubs.update({'dbus': dbus, 'dbus.mainloop': dbus.mainloop,
                      'dbus.mainloop.glib': dbus.mainloop.glib})
    try:
        from gi.repository import GLib  # noqa: F401
    except ImportError:
        gi = types.ModuleType('gi')
        gi.repository = types.ModuleType('gi.repository')
        gi.repository.GLib = types.SimpleNamespace()
        stubs.update({'gi': gi, 'gi.repository': gi.repository})
    with patch.dict(sys.modules, stubs):
        sys.modules.pop('fleet_agent.bluetooth.reconnect', None)
        import fleet_agent.bluetooth.reconnect as mod
    return mod


reconnect = _import_reconnect()


class FakeDBusException(Exception):
    def __init__(self, name):
        super().__init__(name)
        self._name = name

    def get_dbus_name(self):
        return self._name


class FakeGLib:
    """Manual clock for GLib.timeout_add one-shot timers."""

    def __init__(self):
        self.now = 0
        self.timers = {}
        self._next = 1

    def timeout_add(self, ms, fn, *args):
        source = self._next
        self._next += 1
        self.timers[source] = (self.now + ms, fn, args)
        return source

    def source_remove(self, source):
        assert source in self.timers, f'removed unknown GLib source {source}'
        del self.timers[source]

    def advance(self, ms):
        end = self.now + ms
        while True:
            due = [(t, s) for s, (t, _, _) in self.timers.items() if t <= end]
            if not due:
                break
            t, source = min(due)
            _, fn, args = self.timers.pop(source)
            self.now = t
            if fn(*args):
                pytest.fail('repeating GLib timers are not expected')
        self.now = end


class FakeBus:
    """BlueZ as seen over D-Bus: device properties, calls, signal receivers."""

    def __init__(self):
        self.devices = {}     # path -> {'Paired': bool, 'Connected': bool}
        self.calls = []       # in-flight ConnectProfile: (path, reply, error)
        self.started = []     # every ConnectProfile call, by path
        self.receivers = []   # (signal_name, path, fn)
        self.get_object_error = None

    # --- dbus surface used by reconnect.py
    def get_object(self, _service, path):
        if self.get_object_error:
            raise FakeDBusException(self.get_object_error)
        return types.SimpleNamespace(bus=self, path=path)

    def add_signal_receiver(self, fn, dbus_interface=None, signal_name=None, path=None):
        self.receivers.append((signal_name, path, fn))

    def interface(self, obj, iface):
        bus, path = obj.bus, obj.path
        if iface == 'org.freedesktop.DBus.Properties':
            def get_all(_iface):
                if path not in bus.devices:
                    raise FakeDBusException(UNKNOWN_OBJECT)
                return dict(bus.devices[path])
            return types.SimpleNamespace(
                GetAll=get_all, Get=lambda iface, name: get_all(iface)[name])
        if iface == 'org.bluez.Device1':
            def connect_profile(_uuid, reply_handler, error_handler):
                bus.started.append(path)
                bus.calls.append((path, reply_handler, error_handler))
            return types.SimpleNamespace(ConnectProfile=connect_profile)
        if iface == 'org.freedesktop.DBus.ObjectManager':
            return types.SimpleNamespace(GetManagedObjects=lambda: {
                p: {'org.bluez.Device1': dict(props)} for p, props in bus.devices.items()})
        raise AssertionError(f'unexpected interface {iface}')

    # --- test helpers
    def emit(self, signal_name, *args, path=None):
        for name, rpath, fn in list(self.receivers):
            if name == signal_name and rpath in (None, path):
                fn(*args)

    def fail_calls(self, name=FAILED):
        calls, self.calls = self.calls, []
        for _, _, error in calls:
            error(FakeDBusException(name))

    def succeed_calls(self):
        calls, self.calls = self.calls, []
        for path, reply, _ in calls:
            self.devices[path]['Connected'] = True
            reply()

    def receivers_for(self, signal_name, path):
        return [r for r in self.receivers if r[0] == signal_name and r[1] == path]


@pytest.fixture
def env(monkeypatch):
    glib = FakeGLib()
    bus = FakeBus()
    fake_dbus = types.SimpleNamespace(
        Interface=bus.interface,
        exceptions=types.SimpleNamespace(DBusException=FakeDBusException),
        SystemBus=lambda: bus,
    )
    monkeypatch.setattr(reconnect, 'GLib', glib)
    monkeypatch.setattr(reconnect, 'dbus', fake_dbus)
    monkeypatch.setattr(reconnect, '_connecting', set())
    monkeypatch.setattr(reconnect, '_pending', {}, raising=False)
    monkeypatch.setattr(reconnect, '_watched', set(), raising=False)
    return types.SimpleNamespace(glib=glib, bus=bus)


def _timers_for(glib, path):
    return [s for s, (_, _, args) in glib.timers.items() if args[1] == path]


def _repair_cycle(bus):
    """What a failing heal does to BlueZ: remove the device, re-add it paired."""
    del bus.devices[PATH]
    bus.emit('InterfacesRemoved', PATH, ['org.bluez.Device1'])
    bus.devices[PATH] = {'Paired': True, 'Connected': False}
    bus.emit('InterfacesAdded', PATH, {'org.bluez.Device1': dict(bus.devices[PATH])})
    bus.emit('PropertiesChanged', 'org.bluez.Device1', {'Connected': False}, [], path=PATH)


def test_repeated_repairs_keep_one_receiver_and_one_chain(env):
    bus, glib = env.bus, env.glib
    bus.devices[PATH] = {'Paired': True, 'Connected': False}
    reconnect.setup_reconnect_watcher(bus)

    for _ in range(30):
        _repair_cycle(bus)
        glib.advance(5_000)
        bus.fail_calls()
        assert len(_timers_for(glib, PATH)) <= 1
        assert len(bus.calls) == 0

    assert len(bus.receivers_for('PropertiesChanged', PATH)) == 1

    # Ten quiet minutes: one chain backing off to 60s, not dozens per minute.
    before = len(bus.started)
    for _ in range(60):
        glib.advance(10_000)
        assert len(bus.calls) <= 1
        bus.fail_calls()
    assert len(bus.started) - before <= 15


def test_stops_when_device_disappears(env):
    bus, glib = env.bus, env.glib
    bus.devices[PATH] = {'Paired': True, 'Connected': False}
    reconnect.setup_reconnect_watcher(bus)
    glib.advance(2_000)
    bus.fail_calls()
    assert len(_timers_for(glib, PATH)) == 1

    del bus.devices[PATH]  # removed by the pair flow, signal not seen
    glib.advance(60_000)

    assert glib.timers == {}
    assert bus.calls == []
    assert PATH not in reconnect._connecting


def test_stops_on_unknown_object_reply(env):
    bus, glib = env.bus, env.glib
    bus.devices[PATH] = {'Paired': True, 'Connected': False}
    reconnect.setup_reconnect_watcher(bus)
    glib.advance(2_000)

    bus.fail_calls(UNKNOWN_OBJECT)

    assert glib.timers == {}
    assert PATH not in reconnect._connecting


def test_does_not_connect_an_unpaired_device(env):
    bus, glib = env.bus, env.glib
    bus.devices[PATH] = {'Paired': True, 'Connected': False}
    reconnect.setup_reconnect_watcher(bus)
    bus.devices[PATH]['Paired'] = False  # pair flow cleared the bond

    glib.advance(2_000)

    assert bus.started == []
    assert glib.timers == {}


def test_interfaces_removed_cancels_scheduled_attempt(env):
    bus, glib = env.bus, env.glib
    bus.devices[PATH] = {'Paired': True, 'Connected': False}
    reconnect.setup_reconnect_watcher(bus)
    assert len(_timers_for(glib, PATH)) == 1

    del bus.devices[PATH]
    bus.emit('InterfacesRemoved', PATH, ['org.bluez.Device1'])

    assert glib.timers == {}
    glib.advance(120_000)
    assert bus.started == []


def test_no_second_call_while_one_is_in_flight(env):
    bus, glib = env.bus, env.glib
    bus.devices[PATH] = {'Paired': True, 'Connected': False}
    reconnect.setup_reconnect_watcher(bus)
    glib.advance(2_000)
    assert len(bus.calls) == 1

    # A re-announce schedules another attempt while the call is pending.
    bus.emit('InterfacesAdded', PATH, {'org.bluez.Device1': dict(bus.devices[PATH])})
    glib.advance(2_000)
    assert len(bus.calls) == 1
    assert glib.timers == {}

    bus.fail_calls()  # the in-flight call owns the retry
    assert len(_timers_for(glib, PATH)) == 1


def test_get_object_failure_retries_instead_of_wedging(env):
    bus, glib = env.bus, env.glib
    bus.devices[PATH] = {'Paired': True, 'Connected': False}
    reconnect.setup_reconnect_watcher(bus)

    bus.get_object_error = 'org.freedesktop.DBus.Error.ServiceUnknown'
    glib.advance(2_000)
    assert PATH not in reconnect._connecting
    assert len(_timers_for(glib, PATH)) == 1

    bus.get_object_error = None
    glib.advance(4_000)
    assert bus.started == [PATH]


def test_backoff_doubles_to_the_cap_then_success_stops(env):
    bus, glib = env.bus, env.glib
    bus.devices[PATH] = {'Paired': True, 'Connected': False}
    reconnect.setup_reconnect_watcher(bus)

    delays = []
    glib.advance(2_000)
    for _ in range(7):
        bus.fail_calls()
        (source,) = _timers_for(glib, PATH)
        delays.append(glib.timers[source][0] - glib.now)
        glib.advance(delays[-1])
    assert delays == [4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]

    bus.succeed_calls()
    assert glib.timers == {}
    assert PATH not in reconnect._connecting


def test_disconnect_signal_schedules_one_attempt(env):
    bus, glib = env.bus, env.glib
    bus.devices[PATH] = {'Paired': True, 'Connected': True}
    reconnect.setup_reconnect_watcher(bus)
    assert glib.timers == {}

    bus.devices[PATH]['Connected'] = False
    for _ in range(5):
        bus.emit('PropertiesChanged', 'org.bluez.Device1', {'Connected': False}, [], path=PATH)
    assert len(_timers_for(glib, PATH)) == 1

    glib.advance(reconnect.INITIAL_DELAY_MS)
    assert bus.started == [PATH]
