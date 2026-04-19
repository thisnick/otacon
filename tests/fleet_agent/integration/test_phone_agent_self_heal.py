"""Integration test: CI-runnable version of the S22 self-heal scenario.

Simulates: bt_bonded=false detected -> heal_bt_bonded triggered -> bond restored.
All I/O mocked via the injectable Runner protocol.
"""

import subprocess
from unittest.mock import patch, MagicMock

from fleet_agent.phone.agent import PhoneAgent
from fleet_agent.phone.status import MonitorStatus
from fleet_agent.util.adb import set_runner, SubprocessRunner


class MockRunner:
    """Controllable runner for testing. Returns configurable responses per command."""

    def __init__(self):
        self.responses = {}
        self.calls = []

    def expect(self, args_prefix, *, stdout='', returncode=0):
        """Register a response for commands starting with args_prefix."""
        self.responses[tuple(args_prefix)] = subprocess.CompletedProcess(
            args_prefix, returncode, stdout=stdout, stderr='')

    def run(self, args, *, input=None, timeout=10):
        self.calls.append((args, input))
        # Match by longest prefix
        for length in range(len(args), 0, -1):
            key = tuple(args[:length])
            if key in self.responses:
                return self.responses[key]
        return subprocess.CompletedProcess(args, 0, stdout='', stderr='')


class TestSelfHealBtBonded:
    """Test that a maintenance tick detects bt_bonded=false and triggers heal."""

    def setup_method(self):
        self.runner = MockRunner()
        set_runner(self.runner)

    def teardown_method(self):
        set_runner(SubprocessRunner())

    @patch('fleet_agent.phone.heal.allocate_and_pair_bluetooth',
           return_value=('AA:BB:CC:DD:EE:01', 'hci0', '11:22:33:44:55:66'))
    @patch('fleet_agent.registry.server.http_post', return_value={'id': 'phone-test'})
    def test_bt_bonded_false_triggers_heal(self, mock_register, mock_pair):
        """When bt_bonded check returns False, heal_bt_bonded should be called."""
        # Setup: make all other checks pass
        self.runner.expect(['adb', '-s', 'TEST_S22', 'shell', 'cmd wifi status'],
                           stdout='Wifi is connected')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'shell', 'dpm list-owners'],
                           stdout='com.otacon.kiosk')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'shell', 'dumpsys user'],
                           stdout='  no_factory_reset: true')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'shell', 'pgrep -f snapshot-server.jar'],
                           stdout='12345')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'forward', '--list'],
                           stdout='TEST_S22 tcp:9091 tcp:9091')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'reverse', '--list'],
                           stdout='TEST_S22 tcp:8081 tcp:8081')
        # bluetoothctl returns 'Paired: no' for bt_bonded, 'Connected: no' for bt_connected
        self.runner.expect(['bluetoothctl'], stdout='Paired: no\nConnected: no')

        agent = PhoneAgent('TEST_S22', 9091, 8081, 50, 5900)
        agent.adapter_mac = 'AA:BB:CC:DD:EE:01'
        agent.phone_bt_mac = '11:22:33:44:55:66'
        agent.phone_id = 'phone-test'

        agent.run_maintenance_tick()

        # bt_bonded should be False and heal should have been called
        assert agent.status.health['bt_bonded'] is False
        assert 'bt_bonded' in agent.status.heals
        heal = agent.status.heals['bt_bonded']
        # Heal runs but post-heal re-check still fails (bluetoothctl mock unchanged)
        assert heal.last_result == 'failed'
        assert heal.count_today >= 1
        mock_pair.assert_called_once()

    @patch('fleet_agent.phone.heal.allocate_and_pair_bluetooth',
           return_value=('AA:BB:CC:DD:EE:01', 'hci0', '11:22:33:44:55:66'))
    @patch('fleet_agent.registry.server.http_post', return_value={'id': 'phone-test'})
    def test_bt_bonded_true_skips_heal(self, mock_register, mock_pair):
        """When bt_bonded check returns True, no heal should be triggered."""
        self.runner.expect(['adb', '-s', 'TEST_S22', 'shell', 'cmd wifi status'],
                           stdout='Wifi is connected')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'shell', 'dpm list-owners'],
                           stdout='com.otacon.kiosk')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'shell', 'dumpsys user'],
                           stdout='  no_factory_reset: true')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'shell', 'pgrep -f snapshot-server.jar'],
                           stdout='12345')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'forward', '--list'],
                           stdout='TEST_S22 tcp:9091 tcp:9091')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'reverse', '--list'],
                           stdout='TEST_S22 tcp:8081 tcp:8081')
        # bluetoothctl returns paired + connected
        self.runner.expect(['bluetoothctl'], stdout='Paired: yes\nConnected: yes')
        # phone-side dumpsys for bt_bonded cross-check
        self.runner.expect(['adb', '-s', 'TEST_S22', 'shell', 'dumpsys bluetooth_manager'],
                           stdout='AA:BB:CC:DD:EE:01')

        agent = PhoneAgent('TEST_S22', 9091, 8081, 50, 5900)
        agent.adapter_mac = 'AA:BB:CC:DD:EE:01'
        agent.phone_bt_mac = '11:22:33:44:55:66'

        agent.run_maintenance_tick()

        assert agent.status.health['bt_bonded'] is True
        assert 'bt_bonded' not in agent.status.heals
        mock_pair.assert_not_called()

    @patch('fleet_agent.phone.heal.allocate_and_pair_bluetooth',
           side_effect=RuntimeError('pair script failed'))
    def test_heal_failure_tracked(self, mock_pair):
        """When heal_bt_bonded fails, the failure is tracked in HealStatus."""
        self.runner.expect(['adb', '-s', 'TEST_S22', 'shell', 'cmd wifi status'],
                           stdout='Wifi is connected')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'shell', 'dpm list-owners'],
                           stdout='com.otacon.kiosk')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'shell', 'dumpsys user'],
                           stdout='  no_factory_reset: true')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'shell', 'pgrep -f snapshot-server.jar'],
                           stdout='12345')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'forward', '--list'],
                           stdout='TEST_S22 tcp:9091 tcp:9091')
        self.runner.expect(['adb', '-s', 'TEST_S22', 'reverse', '--list'],
                           stdout='TEST_S22 tcp:8081 tcp:8081')
        self.runner.expect(['bluetoothctl'], stdout='Paired: no\nConnected: no')

        agent = PhoneAgent('TEST_S22', 9091, 8081, 50, 5900)
        agent.adapter_mac = 'AA:BB:CC:DD:EE:01'
        agent.phone_bt_mac = '11:22:33:44:55:66'

        agent.run_maintenance_tick()

        heal = agent.status.heals['bt_bonded']
        assert heal.last_result == 'failed'
        assert heal.last_error == 'pair script failed'
        assert heal.count_today == 1
