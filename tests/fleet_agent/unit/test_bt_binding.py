"""Unit tests for the Bluetooth binding failures seen on otacon-pi (2026-10).

1. bluetoothd crashed and restarted; the agent was never re-registered, so
   every new pair was AuthenticationCanceled.
2. A leaked discovery session made every later StartDiscovery fail with
   InProgress, and the pair flow gave up instead of reusing it.
3. Releasing a lost phone's dongle only edited phones.json; the in-memory
   allocation cache still held it, so no other phone could get it.
4. The agent allowlist learned a phone's BT MAC only after a successful pair,
   so a fresh or released assignment could never pair.
5. A dongle that came up DOWN was invisible to allocation forever.
"""

import json
import sys
import types
from unittest.mock import MagicMock, patch

import pytest

import fleet_agent.bluetooth.dongle as dongle_mod
from fleet_agent.bluetooth.dongle import (
    allocate_dongle, bring_up_down_adapters, parse_hciconfig, parse_hciconfig_all,
)
from fleet_agent.phone.health import BtBondedDetail
from fleet_agent.util.ports import PortAllocator

ADAPTER = 'AA:BB:CC:DD:EE:01'
PHONE_BT = '4C:2E:5E:D2:D6:00'

HCICONFIG = """\
hci3:\tType: Primary  Bus: USB
\tBD Address: AA:BB:CC:DD:EE:03  ACL MTU: 679:6  SCO MTU: 240:20
\tDOWN
\tRX bytes:35021 acl:683 sco:0 events:952 errors:0

hci2:\tType: Primary  Bus: USB
\tBD Address: AA:BB:CC:DD:EE:02  ACL MTU: 679:6  SCO MTU: 240:20
\tUP RUNNING PSCAN
\tRX bytes:444016 acl:3092 sco:0 events:18551 errors:0
"""


class FakeDBusException(Exception):
    def __init__(self, name, message=''):
        super().__init__(f'{name}: {message}')
        self._name = name

    def get_dbus_name(self):
        return self._name


@pytest.fixture(autouse=True)
def reset_dongle_cache():
    dongle_mod._dongle_cache = None
    dongle_mod._bt_mac_cache = {}
    yield
    dongle_mod._dongle_cache = None
    dongle_mod._bt_mac_cache = {}


# ---------------------------------------------------------------------------
# 3. Released dongles must leave the in-memory cache
# ---------------------------------------------------------------------------

class TestReleasedDongleIsReallocatable:
    def test_release_frees_dongle_for_another_phone(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        with open(path, 'w') as f:
            json.dump([{'adb_serial': 'LOST', 'adapter_mac': ADAPTER,
                        'phone_bt_mac': PHONE_BT}], f)

        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path), \
             patch('fleet_agent.bluetooth.dongle.PHONES_JSON_PATH', path), \
             patch('fleet_agent.bluetooth.dongle.enum_dongles',
                   return_value={ADAPTER: 'hci0'}):
            assert allocate_dongle('NEW') is None  # held by LOST

            PortAllocator().release_dongle(ADAPTER.lower())

            result = allocate_dongle('NEW')
            assert result is not None
            assert result[0] == ADAPTER


# ---------------------------------------------------------------------------
# 5. DOWN adapters are brought back up
# ---------------------------------------------------------------------------

class TestDownAdapters:
    def test_parse_all_reports_up_and_down(self):
        assert parse_hciconfig_all(HCICONFIG) == {
            'AA:BB:CC:DD:EE:03': ('hci3', False),
            'AA:BB:CC:DD:EE:02': ('hci2', True),
        }

    def test_parse_hciconfig_still_only_up(self):
        assert parse_hciconfig(HCICONFIG) == {'AA:BB:CC:DD:EE:02': 'hci2'}

    def test_brings_up_only_down_adapters(self):
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            out = HCICONFIG if args == ['hciconfig'] else ''
            return MagicMock(stdout=out, stderr='', returncode=0)

        with patch('fleet_agent.bluetooth.dongle.run_cmd', side_effect=fake_run):
            assert bring_up_down_adapters() == ['hci3']
        assert ['hciconfig', 'hci3', 'up'] in calls
        assert ['hciconfig', 'hci2', 'up'] not in calls

    def test_loss_sweep_brings_adapters_up_with_bluetooth_backend(self, monkeypatch):
        # manager imports the dbus-backed agent; stub as test_loss_sweep does
        for name in ('dbus', 'dbus.mainloop', 'dbus.mainloop.glib',
                     'dbus.service', 'gi', 'gi.repository'):
            if name not in sys.modules:
                monkeypatch.setitem(sys.modules, name, MagicMock())
        from fleet_agent.manager import FleetAgent
        monkeypatch.setenv('AUDIO_BACKEND', 'bluetooth')
        fa = FleetAgent(time_fn=lambda: 1000.0)
        with patch('fleet_agent.manager.bring_up_down_adapters') as up, \
             patch('fleet_agent.manager.load_dongle_assignments', return_value={}), \
             patch.object(fa, 'report_dongles') as report:
            fa.loss_sweep()
        up.assert_called_once()
        report.assert_called_once()


class TestReportDongles:
    def _fleet_agent(self, monkeypatch):
        for name in ('dbus', 'dbus.mainloop', 'dbus.mainloop.glib',
                     'dbus.service', 'gi', 'gi.repository'):
            if name not in sys.modules:
                monkeypatch.setitem(sys.modules, name, MagicMock())
        from fleet_agent.manager import FleetAgent
        monkeypatch.setenv('REGISTRY_URL', 'http://registry')
        monkeypatch.setenv('HOST_ID', 'pi')
        fa = FleetAgent(time_fn=lambda: 0.0)
        agent = MagicMock(registry_id='phone-2', phone_id='phone-r5ct60sd')
        fa.agents['SER'] = (agent, MagicMock())
        return fa

    def test_reports_registry_id_only_when_changed(self, monkeypatch):
        fa = self._fleet_agent(monkeypatch)
        with patch('fleet_agent.manager.enum_dongles', return_value={ADAPTER: 'hci2'}), \
             patch('fleet_agent.manager.load_dongle_assignments',
                   return_value={'SER': ADAPTER}), \
             patch('fleet_agent.registry.client._http_post') as post:
            fa.report_dongles()
            fa.report_dongles()

        post.assert_called_once()
        assert post.call_args[0][1]['dongles'] == [
            {'bt_mac': ADAPTER, 'hci_device': 'hci2', 'phone_id': 'phone-2'}]

    def test_failed_report_is_retried(self, monkeypatch):
        fa = self._fleet_agent(monkeypatch)
        with patch('fleet_agent.manager.enum_dongles', return_value={ADAPTER: 'hci2'}), \
             patch('fleet_agent.manager.load_dongle_assignments', return_value={}), \
             patch('fleet_agent.registry.client._http_post',
                   side_effect=[OSError('down'), None]) as post:
            fa.report_dongles()
            fa.report_dongles()

        assert post.call_count == 2


# ---------------------------------------------------------------------------
# 2. Discovery InProgress is reused, then stopped
# ---------------------------------------------------------------------------

def _fake_pair_dbus(device_path):
    """Fake `dbus` module wired for one adapter and one discoverable phone."""
    adapter = MagicMock()
    adapter.StartDiscovery.side_effect = FakeDBusException('org.bluez.Error.InProgress')
    manager = MagicMock()
    manager.GetManagedObjects.return_value = {
        device_path: {'org.bluez.Device1': {'Address': PHONE_BT}},
    }
    device = MagicMock()
    props = MagicMock()
    props.Get.return_value = True

    ifaces = {
        'org.bluez.Adapter1': adapter,
        'org.freedesktop.DBus.ObjectManager': manager,
        'org.bluez.Device1': device,
        'org.freedesktop.DBus.Properties': props,
    }
    fake = types.ModuleType('dbus')
    fake.DBusException = FakeDBusException
    fake.SystemBus = MagicMock()
    fake.Interface = lambda obj, iface: ifaces[iface]
    return fake, adapter, device


class TestDiscoveryInProgress:
    def test_reuses_running_discovery_and_stops_it(self):
        from fleet_agent.bluetooth.pair import _dbus_discover_and_pair
        path = '/org/bluez/hci2/dev_4C_2E_5E_D2_D6_00'
        fake, adapter, device = _fake_pair_dbus(path)

        with patch.dict(sys.modules, {'dbus': fake}), \
             patch('fleet_agent.bluetooth.pair.time.sleep'):
            paired, connected = _dbus_discover_and_pair('hci2', PHONE_BT, 'SER')

        assert (paired, connected) == (True, True)
        device.Pair.assert_called_once()
        adapter.StopDiscovery.assert_called_once()

    def test_other_start_errors_still_abort(self):
        from fleet_agent.bluetooth.pair import _dbus_discover_and_pair
        fake, adapter, device = _fake_pair_dbus('/org/bluez/hci2/dev_X')
        adapter.StartDiscovery.side_effect = FakeDBusException('org.bluez.Error.NotReady')

        with patch.dict(sys.modules, {'dbus': fake}), \
             patch('fleet_agent.bluetooth.pair.time.sleep'):
            assert _dbus_discover_and_pair('hci2', PHONE_BT, 'SER') == (False, False)
        device.Pair.assert_not_called()


class TestPhoneInitiatedPair:
    def test_waits_for_bond_without_scanning_or_outbound_pair(self):
        from fleet_agent.bluetooth.pair import _dbus_discover_and_pair
        path = '/org/bluez/hci2/dev_4C_2E_5E_D2_D6_00'
        fake, adapter, device = _fake_pair_dbus(path)
        manager = fake.Interface(None, 'org.freedesktop.DBus.ObjectManager')
        manager.GetManagedObjects.side_effect = [
            {path: {'org.bluez.Device1': {'Address': PHONE_BT, 'Paired': False}}},
            {path: {'org.bluez.Device1': {'Address': PHONE_BT, 'Paired': True}}},
        ]

        with patch.dict(sys.modules, {'dbus': fake}), \
             patch('fleet_agent.bluetooth.pair.time.sleep'):
            result = _dbus_discover_and_pair('hci2', PHONE_BT, 'SER', phone_initiated=True)

        assert result == (True, True)
        assert manager.GetManagedObjects.call_count == 2
        adapter.StartDiscovery.assert_not_called()
        adapter.StopDiscovery.assert_not_called()
        device.Pair.assert_not_called()

    def test_unbonded_cached_device_does_not_count_as_paired(self):
        from fleet_agent.bluetooth.pair import _dbus_discover_and_pair
        path = '/org/bluez/hci2/dev_4C_2E_5E_D2_D6_00'
        fake, adapter, device = _fake_pair_dbus(path)

        with patch.dict(sys.modules, {'dbus': fake}), \
             patch('fleet_agent.bluetooth.pair.time.sleep'):
            result = _dbus_discover_and_pair(
                'hci2', PHONE_BT, 'SER', discovery_timeout=2, phone_initiated=True)

        assert result == (False, False)
        device.Pair.assert_not_called()
        device.Connect.assert_not_called()

    def test_bluez_flow_never_requests_phone_visibility(self):
        import threading
        from fleet_agent.bluetooth.pair import _run_bluez_pair
        path = '/org/bluez/hci2/dev_4C_2E_5E_D2_D6_00'
        fake, adapter, device = _fake_pair_dbus(path)
        ready = threading.Event()

        def wait_for_phone(*args, **kwargs):
            assert ready.is_set()
            return True, True

        with patch.dict(sys.modules, {'dbus': fake}), \
             patch('fleet_agent.bluetooth.pair.time.sleep'), \
             patch('fleet_agent.bluetooth.pair._btctl', return_value='Controller'), \
             patch('fleet_agent.bluetooth.pair.adb_shell', return_value=PHONE_BT) as adb, \
             patch('fleet_agent.bluetooth.pair._dbus_discover_and_pair',
                   side_effect=wait_for_phone) as wait:
            _run_bluez_pair(ADAPTER, 'hci2', 'SER', ready)

        wait.assert_called_once_with(
            'hci2', PHONE_BT, 'SER', discovery_timeout=35, phone_initiated=True)
        assert all('REQUEST_DISCOVERABLE' not in c.args[1] for c in adb.call_args_list)
        assert all('bluetooth_manager enable' not in c.args[1] for c in adb.call_args_list)

    def test_missing_adapter_cannot_borrow_another_adapters_bond(self):
        from fleet_agent.bluetooth.pair import _bluez_is_paired
        fake = types.ModuleType('dbus')
        fake.SystemBus = MagicMock()
        fake.Interface = MagicMock()
        fake.SystemBus.return_value.get_object.side_effect = RuntimeError('UnknownObject')

        with patch.dict(sys.modules, {'dbus': fake}):
            assert _bluez_is_paired('hci3', PHONE_BT) is False

        fake.SystemBus.return_value.get_object.assert_called_once_with(
            'org.bluez', '/org/bluez/hci3/dev_4C_2E_5E_D2_D6_00')


class TestClearPhoneBond:
    def test_pixel_uses_targeted_unpair(self):
        from fleet_agent.bluetooth.pair import _clear_phone_bond
        with patch('fleet_agent.bluetooth.pair.adb_shell',
                   return_value='Row: 0 ok=true, status=removed') as adb, \
             patch('fleet_agent.bluetooth.pair._nuke_phone_bt_bonds') as nuke:
            _clear_phone_bond('SER', ADAPTER)

        assert f'bluetooth/unpair?mac={ADAPTER}' in adb.call_args.args[1]
        nuke.assert_not_called()

    def test_failed_targeted_unpair_falls_back(self):
        from fleet_agent.bluetooth.pair import _clear_phone_bond
        with patch('fleet_agent.bluetooth.pair.adb_shell', return_value='Row: 0 ok=false'), \
             patch('fleet_agent.bluetooth.pair._nuke_phone_bt_bonds') as nuke:
            _clear_phone_bond('SER', ADAPTER)

        nuke.assert_called_once_with('SER')


# ---------------------------------------------------------------------------
# 4. Assignment recorded before pairing; setup keeps a working bond
# ---------------------------------------------------------------------------

@pytest.fixture
def pair_env(monkeypatch):
    """Patch everything allocate_and_pair_bluetooth touches outside itself."""
    monkeypatch.setenv('AUDIO_BACKEND', 'bluetooth')

    def fake_adb_shell(serial, cmd, timeout=10):
        if 'bluetooth_address' in cmd:
            return PHONE_BT + '\n'
        if 'bluetooth/pair' in cmd:
            return 'Row: 0 ok=true paired'
        return ''

    order = MagicMock()
    p = 'fleet_agent.bluetooth.pair.'
    patches = [
        patch(p + 'allocate_dongle', return_value=(ADAPTER, 'hci2', None)),
        patch(p + 'enum_dongles', return_value={ADAPTER: 'hci2'}),
        patch(p + 'adb_shell', side_effect=fake_adb_shell),
        patch(p + 'ensure_screen_on'),
        patch(p + '_run_bluez_pair', side_effect=lambda mac, hci, serial, ready: ready.set()),
        patch(p + '_do_pair_tap_loop'),
        patch(p + 'apply_restrictions'),
        patch(p + 'run_cmd', return_value=MagicMock(stdout='Paired: yes')),
        patch(p + 'time.sleep'),
    ]
    for pt in patches:
        pt.start()
    save = patch(p + 'save_dongle_assignment').start()
    nuke = patch(p + '_nuke_phone_bt_bonds').start()
    bonded = patch('fleet_agent.phone.health.check_bt_bonded',
                   return_value=BtBondedDetail(pi=True, phone=True)).start()
    connected = patch('fleet_agent.phone.health.check_bt_connected',
                      return_value=True).start()
    order.attach_mock(save, 'save')
    order.attach_mock(nuke, 'nuke')
    yield types.SimpleNamespace(save=save, nuke=nuke, bonded=bonded,
                                connected=connected, order=order)
    patch.stopall()


class TestAllocateAndPair:
    def test_records_phone_before_pairing(self, pair_env):
        from fleet_agent.bluetooth.pair import allocate_and_pair_bluetooth
        pair_env.connected.return_value = False

        allocate_and_pair_bluetooth('SER', 'http://snap', force_repair=True)

        names = [c[0] for c in pair_env.order.mock_calls]
        assert names.index('save') < names.index('nuke')
        assert pair_env.order.mock_calls[0] == (
            'save', ('SER', ADAPTER, PHONE_BT), {})

    def test_setup_keeps_connected_bond(self, pair_env):
        from fleet_agent.bluetooth.pair import allocate_and_pair_bluetooth

        result = allocate_and_pair_bluetooth('SER', 'http://snap')

        assert result == (ADAPTER, 'hci2', PHONE_BT, None)
        pair_env.nuke.assert_not_called()

    def test_setup_keeps_disconnected_bond(self, pair_env):
        from fleet_agent.bluetooth.pair import allocate_and_pair_bluetooth
        pair_env.connected.return_value = False

        result = allocate_and_pair_bluetooth('SER', 'http://snap')

        assert result == (ADAPTER, 'hci2', PHONE_BT, None)
        pair_env.nuke.assert_not_called()

    @pytest.mark.parametrize('pi,phone', [(True, False), (False, True), (False, False)])
    def test_missing_bond_is_repaired(self, pair_env, pi, phone):
        from fleet_agent.bluetooth.pair import allocate_and_pair_bluetooth
        pair_env.bonded.return_value = BtBondedDetail(pi=pi, phone=phone)

        allocate_and_pair_bluetooth('SER', 'http://snap')

        pair_env.nuke.assert_called_once_with('SER')

    def test_explicit_pair_can_replace_existing_bond(self, pair_env):
        from fleet_agent.bluetooth.pair import allocate_and_pair_bluetooth

        allocate_and_pair_bluetooth('SER', 'http://snap', force_repair=True)

        pair_env.nuke.assert_called_once_with('SER')


# ---------------------------------------------------------------------------
# 1. Agent re-registers when bluetoothd restarts
# ---------------------------------------------------------------------------

@pytest.fixture
def agent_mod():
    """Import bluetooth.agent against fake dbus/gi modules."""
    dbus = types.ModuleType('dbus')
    dbus.exceptions = types.ModuleType('dbus.exceptions')
    dbus.exceptions.DBusException = FakeDBusException
    dbus.service = types.ModuleType('dbus.service')
    dbus.service.Object = object
    dbus.service.method = lambda *a, **k: (lambda f: f)
    dbus.mainloop = types.ModuleType('dbus.mainloop')
    dbus.mainloop.glib = types.ModuleType('dbus.mainloop.glib')
    dbus.Interface = MagicMock()
    dbus.SystemBus = MagicMock()
    dbus.UInt32 = int
    gi = types.ModuleType('gi')
    gi.repository = types.ModuleType('gi.repository')
    gi.repository.GLib = MagicMock()

    fakes = {
        'dbus': dbus, 'dbus.exceptions': dbus.exceptions,
        'dbus.service': dbus.service, 'dbus.mainloop': dbus.mainloop,
        'dbus.mainloop.glib': dbus.mainloop.glib,
        'gi': gi, 'gi.repository': gi.repository,
    }
    import fleet_agent.bluetooth as bt_pkg
    # Restore both sys.modules and the package attribute afterwards so other
    # tests keep whatever agent module they had.
    with patch.dict(sys.modules, fakes), patch.dict(bt_pkg.__dict__):
        sys.modules.pop('fleet_agent.bluetooth.agent', None)
        import fleet_agent.bluetooth.agent as mod
        yield mod


class TestBluetoothdRestart:
    def _watch(self, mod, owner=':1.5'):
        bus = MagicMock()
        bus.get_name_owner.return_value = owner
        mod._watch_bluetoothd_restarts(bus)
        name, callback = bus.watch_name_owner.call_args[0]
        assert name == 'org.bluez'
        return bus, callback

    def test_same_owner_and_departure_do_nothing(self, agent_mod):
        _, on_owner = self._watch(agent_mod)
        on_owner(':1.5')  # dbus-python reports the current owner once
        on_owner('')      # bluetoothd exiting
        agent_mod.GLib.timeout_add_seconds.assert_not_called()

    def test_new_owner_reregisters_and_relocks_adapters(self, agent_mod):
        bus, on_owner = self._watch(agent_mod)
        on_owner(':1.9')

        agent_mod.GLib.timeout_add_seconds.assert_called_once()
        retry = agent_mod.GLib.timeout_add_seconds.call_args[0][1]
        with patch.object(agent_mod, '_register_with_bluez') as reg, \
             patch.object(agent_mod, 'silence_all_adapters') as silence:
            assert retry() is False  # done, don't reschedule
        reg.assert_called_once_with(bus)
        silence.assert_called_once()

    def test_retries_until_bluez_is_ready(self, agent_mod):
        _, on_owner = self._watch(agent_mod)
        on_owner(':1.9')
        retry = agent_mod.GLib.timeout_add_seconds.call_args[0][1]

        not_ready = FakeDBusException('org.freedesktop.DBus.Error.UnknownObject')
        with patch.object(agent_mod, '_register_with_bluez', side_effect=not_ready), \
             patch.object(agent_mod, 'silence_all_adapters') as silence:
            results = [retry() for _ in range(15)]
        assert results[:14] == [True] * 14
        assert results[14] is False  # gives up after 15
        silence.assert_not_called()
