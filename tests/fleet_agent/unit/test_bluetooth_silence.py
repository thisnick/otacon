"""Unit tests for BT silence-by-default behavior.

Tests that:
1. At startup, all adapters are set to Discoverable=false
2. enable/disable_discoverable issue the right bluetoothctl commands
3. During pair, only the specific adapter being paired gets Discoverable=true
4. After pair (success or failure), Discoverable is restored to false
5. check_bt_silent health check works correctly
"""

from unittest.mock import patch, MagicMock, call

import pytest

try:
    import dbus
    HAS_DBUS = True
except ImportError:
    HAS_DBUS = False


@pytest.mark.skipif(not HAS_DBUS, reason='dbus not available on this platform')
class TestSilenceAllAdapters:
    """Verify silence_all_adapters sets Discoverable=false on all adapters."""

    def _make_mock_bus(self, adapter_paths):
        """Build a mock D-Bus with the given adapter paths."""
        bus = MagicMock()
        manager_iface = MagicMock()

        managed_objects = {}
        adapter_props = {}

        for path, mac in adapter_paths:
            props_iface = MagicMock()

            def make_get(m):
                def get_fn(iface, prop):
                    if prop == 'Address':
                        return m
                    if prop == 'Alias':
                        return f'Otacon-{m.replace(":", "")[-4:].upper()}'
                    if prop == 'Discoverable':
                        return False
                    return ''
                return get_fn

            props_iface.Get = MagicMock(side_effect=make_get(mac))
            props_iface.Set = MagicMock()
            adapter_props[path] = props_iface

            managed_objects[path] = {
                'org.bluez.Adapter1': {
                    'Address': mac,
                    'Alias': f'hci-{mac}',
                }
            }

        manager_iface.GetManagedObjects.return_value = managed_objects

        def get_object(bus_name, path):
            obj = MagicMock()
            return obj

        bus.get_object = get_object

        return bus, manager_iface, adapter_props

    @patch('dbus.SystemBus')
    def test_all_adapters_set_discoverable_false(self, mock_system_bus):
        from fleet_agent.bluetooth.agent import silence_all_adapters

        adapters = [
            ('/org/bluez/hci0', 'AA:BB:CC:DD:00:01'),
            ('/org/bluez/hci1', 'AA:BB:CC:DD:00:02'),
            ('/org/bluez/hci2', 'AA:BB:CC:DD:00:03'),
            ('/org/bluez/hci3', 'AA:BB:CC:DD:00:04'),
        ]

        bus, manager_iface, adapter_props_map = self._make_mock_bus(adapters)
        mock_system_bus.return_value = bus

        # Re-wire get_object + Interface so each path gets its own props mock
        path_to_obj = {}
        for path, mac in adapters:
            obj = MagicMock()
            path_to_obj[path] = obj

        def get_object(bus_name, path):
            return path_to_obj.get(path, MagicMock())

        bus.get_object = get_object

        path_to_props = {}
        for (path, mac), (_, props) in zip(adapters, adapter_props_map.items()):
            path_to_props[id(path_to_obj[path])] = props

        def mock_interface(obj, iface_name):
            if iface_name == 'org.freedesktop.DBus.ObjectManager':
                return manager_iface
            if iface_name == 'org.freedesktop.DBus.Properties':
                return path_to_props.get(id(obj), MagicMock())
            return MagicMock()

        with patch('dbus.Interface', side_effect=mock_interface):
            silence_all_adapters()

        # Verify each adapter had Discoverable set to False
        for path, mac in adapters:
            props = path_to_props[id(path_to_obj[path])]
            disc_calls = [
                c for c in props.Set.call_args_list
                if len(c[0]) >= 3 and c[0][1] == 'Discoverable'
            ]
            assert len(disc_calls) > 0, (
                f'Adapter {path} ({mac}): Discoverable was never set'
            )
            # Must be set to False
            assert disc_calls[0][0][2] is False, (
                f'Adapter {path} ({mac}): Discoverable should be False, got {disc_calls[0][0][2]}'
            )


class TestEnableDiscoverable:
    def test_issues_correct_bluetoothctl_commands(self):
        from fleet_agent.bluetooth.pair import enable_discoverable
        mock_result = MagicMock(stdout='', stderr='', returncode=0)
        with patch('fleet_agent.bluetooth.pair.run_cmd', return_value=mock_result) as mock_run:
            enable_discoverable('AA:BB:CC:DD:EE:01', timeout_seconds=120)
            mock_run.assert_called_once()
            args, kwargs = mock_run.call_args
            assert args[0] == ['bluetoothctl']
            input_text = kwargs.get('input', '')
            assert 'select AA:BB:CC:DD:EE:01' in input_text
            assert 'discoverable-timeout 120' in input_text
            assert 'discoverable on' in input_text

    def test_custom_timeout(self):
        from fleet_agent.bluetooth.pair import enable_discoverable
        mock_result = MagicMock(stdout='', stderr='', returncode=0)
        with patch('fleet_agent.bluetooth.pair.run_cmd', return_value=mock_result) as mock_run:
            enable_discoverable('AA:BB:CC:DD:EE:01', timeout_seconds=60)
            input_text = mock_run.call_args[1].get('input', '')
            assert 'discoverable-timeout 60' in input_text


class TestDisableDiscoverable:
    def test_issues_correct_bluetoothctl_commands(self):
        from fleet_agent.bluetooth.pair import disable_discoverable
        mock_result = MagicMock(stdout='', stderr='', returncode=0)
        with patch('fleet_agent.bluetooth.pair.run_cmd', return_value=mock_result) as mock_run:
            disable_discoverable('AA:BB:CC:DD:EE:01')
            mock_run.assert_called_once()
            args, kwargs = mock_run.call_args
            assert args[0] == ['bluetoothctl']
            input_text = kwargs.get('input', '')
            assert 'select AA:BB:CC:DD:EE:01' in input_text
            assert 'discoverable off' in input_text

    def test_idempotent_on_failure(self):
        from fleet_agent.bluetooth.pair import disable_discoverable
        with patch('fleet_agent.bluetooth.pair.run_cmd', side_effect=Exception('fail')):
            # Should not raise — _btctl swallows exceptions
            disable_discoverable('AA:BB:CC:DD:EE:01')


class TestCheckBtSilent:
    def test_returns_true_when_no_adapter(self):
        from fleet_agent.phone.health import check_bt_silent
        assert check_bt_silent(None) is True

    def test_returns_true_when_not_discoverable(self):
        from fleet_agent.phone.health import check_bt_silent
        mock_result = MagicMock(
            stdout='Controller AA:BB:CC:DD:EE:01\n\tDiscoverable: no\n',
            stderr='', returncode=0,
        )
        with patch('fleet_agent.phone.health.run_cmd', return_value=mock_result):
            assert check_bt_silent('AA:BB:CC:DD:EE:01') is True

    def test_returns_false_when_discoverable(self):
        from fleet_agent.phone.health import check_bt_silent
        mock_result = MagicMock(
            stdout='Controller AA:BB:CC:DD:EE:01\n\tDiscoverable: yes\n',
            stderr='', returncode=0,
        )
        with patch('fleet_agent.phone.health.run_cmd', return_value=mock_result):
            assert check_bt_silent('AA:BB:CC:DD:EE:01') is False

    def test_returns_true_on_exception(self):
        from fleet_agent.phone.health import check_bt_silent
        with patch('fleet_agent.phone.health.run_cmd', side_effect=Exception('fail')):
            assert check_bt_silent('AA:BB:CC:DD:EE:01') is True


class TestPairDiscoverableLifecycle:
    """Verify that _run_bluez_pair enables discoverable on the specific adapter
    and disables it after completion."""

    @patch('fleet_agent.bluetooth.pair.adb_shell', return_value='11:22:33:44:55:66')
    @patch('fleet_agent.bluetooth.pair.run_cmd')
    @patch('fleet_agent.bluetooth.pair.ensure_screen_on')
    def test_discoverable_on_then_off_during_pair(self, mock_screen, mock_run_cmd, mock_adb):
        """During _run_bluez_pair, the adapter goes discoverable on, then off."""
        from fleet_agent.bluetooth.pair import _run_bluez_pair

        btctl_outputs = []

        def fake_run_cmd(cmd, input=None, timeout=15):
            result = MagicMock(stdout='Controller AA:BB:CC:DD:00:01', stderr='', returncode=0)
            if input:
                btctl_outputs.append(input)
                if 'info' in input:
                    result.stdout = 'Paired: no\nConnected: no'
                elif 'pair' in input:
                    result.stdout = 'Pairing successful'
                elif 'connect' in input:
                    result.stdout = 'Connection successful'
            return result

        mock_run_cmd.side_effect = fake_run_cmd

        _run_bluez_pair('AA:BB:CC:DD:00:01', 'hci0', 'TEST_SERIAL')

        # Collect all bluetoothctl command strings
        all_cmds = '\n'.join(btctl_outputs)

        # Must have discoverable on (during pair)
        assert 'discoverable on' in all_cmds, (
            'Expected "discoverable on" during pair flow'
        )
        # Must have discoverable off (after pair completes)
        assert 'discoverable off' in all_cmds, (
            'Expected "discoverable off" after pair flow'
        )

        # discoverable off must come AFTER discoverable on
        on_idx = all_cmds.index('discoverable on')
        off_idx = all_cmds.index('discoverable off')
        assert off_idx > on_idx, (
            'discoverable off must come after discoverable on'
        )

    @patch('fleet_agent.bluetooth.pair.adb_shell', return_value='11:22:33:44:55:66')
    @patch('fleet_agent.bluetooth.pair.run_cmd')
    @patch('fleet_agent.bluetooth.pair.ensure_screen_on')
    def test_discoverable_off_even_on_pair_failure(self, mock_screen, mock_run_cmd, mock_adb):
        """discoverable off should still be called even when pairing fails."""
        from fleet_agent.bluetooth.pair import _run_bluez_pair

        btctl_outputs = []

        def fake_run_cmd(cmd, input=None, timeout=15):
            result = MagicMock(stdout='Controller AA:BB:CC:DD:00:01', stderr='', returncode=0)
            if input:
                btctl_outputs.append(input)
                if 'info' in input:
                    result.stdout = 'Paired: no'
                elif 'pair' in input:
                    raise Exception('Pairing failed: timeout')
            return result

        mock_run_cmd.side_effect = fake_run_cmd

        # Should not raise even though pair fails
        _run_bluez_pair('AA:BB:CC:DD:00:01', 'hci0', 'TEST_SERIAL')

        all_cmds = '\n'.join(btctl_outputs)

        # discoverable off should still be called (cleanup)
        assert 'discoverable off' in all_cmds, (
            'discoverable off must be called even on pair failure'
        )
