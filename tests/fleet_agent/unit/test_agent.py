"""Unit tests for phone/agent.py — PhoneAgent state machine logic."""

from unittest.mock import patch, MagicMock, call
from dataclasses import asdict

from fleet_agent.phone.agent import PhoneAgent, SETUP_STEPS
from fleet_agent.phone.status import MonitorStatus, StepStatus, HealStatus


class TestPhoneAgentInit:
    def test_initial_state(self, phone_agent):
        assert phone_agent.serial == 'TEST_SERIAL'
        assert phone_agent.snapshot_port == 9091
        assert phone_agent.internal_port == 8081
        assert phone_agent.status.phase == 'setup'
        assert phone_agent.status.loop_iteration == 0

    def test_snapshot_url(self, phone_agent):
        assert phone_agent.snapshot_url == 'http://127.0.0.1:9091'


class TestRunStep:
    def test_tracks_success(self, phone_agent):
        phone_agent._run_step('test_step', lambda: 'ok')
        step = phone_agent.status.setup['test_step']
        assert step.attempted is True
        assert step.succeeded is True
        assert step.error is None

    def test_tracks_failure(self, phone_agent):
        def failing_fn():
            raise RuntimeError('boom')
        phone_agent._run_step('test_step', failing_fn)
        step = phone_agent.status.setup['test_step']
        assert step.attempted is True
        assert step.succeeded is False
        assert step.error == 'boom'

    def test_returns_result_on_success(self, phone_agent):
        result = phone_agent._run_step('test_step', lambda: 42)
        assert result == 42

    def test_returns_none_on_failure(self, phone_agent):
        result = phone_agent._run_step('test_step', lambda: (_ for _ in ()).throw(RuntimeError('boom')))
        assert result is None


class TestGetChecks:
    def test_returns_all_expected_checks(self, phone_agent):
        checks = phone_agent._get_checks()
        expected = {
            'bt_bonded', 'bt_connected', 'wifi', 'device_owner',
            'restrictions', 'snapshot_alive', 'port_forwards',
        }
        assert set(checks.keys()) == expected

    def test_checks_are_callable(self, phone_agent):
        checks = phone_agent._get_checks()
        for name, fn in checks.items():
            assert callable(fn)


class TestRunMaintenanceTick:
    @patch('fleet_agent.phone.health.check_bt_bonded', return_value=True)
    @patch('fleet_agent.phone.health.check_bt_connected', return_value=True)
    @patch('fleet_agent.phone.health.check_wifi_connected', return_value=True)
    @patch('fleet_agent.phone.health.check_device_owner', return_value=True)
    @patch('fleet_agent.phone.health.check_restrictions', return_value=True)
    @patch('fleet_agent.phone.health.check_snapshot_alive', return_value=True)
    @patch('fleet_agent.phone.health.check_port_forwards', return_value=True)
    def test_all_healthy_no_heals(self, *mocks):
        agent = PhoneAgent('TEST', 9091, 8081, 50, 5900)
        agent.adapter_mac = 'AA:BB:CC:DD:EE:01'
        agent.phone_bt_mac = '11:22:33:44:55:66'
        agent.run_maintenance_tick()
        assert agent.status.loop_iteration == 1
        assert agent.status.last_check_at is not None
        assert all(v is True for v in agent.status.health.values())
        assert agent.status.heals == {}

    @patch('fleet_agent.phone.health.check_bt_bonded', return_value=True)
    @patch('fleet_agent.phone.health.check_bt_connected', return_value=True)
    @patch('fleet_agent.phone.health.check_wifi_connected', return_value=False)
    @patch('fleet_agent.phone.health.check_device_owner', return_value=True)
    @patch('fleet_agent.phone.health.check_restrictions', return_value=True)
    @patch('fleet_agent.phone.health.check_snapshot_alive', return_value=True)
    @patch('fleet_agent.phone.health.check_port_forwards', return_value=True)
    @patch('fleet_agent.phone.heal.heal_wifi')
    def test_unhealthy_triggers_heal(self, mock_heal_wifi, *mocks):
        agent = PhoneAgent('TEST', 9091, 8081, 50, 5900)
        agent.adapter_mac = 'AA:BB:CC:DD:EE:01'
        agent.phone_bt_mac = '11:22:33:44:55:66'
        agent.run_maintenance_tick()
        assert agent.status.health['wifi'] is False
        assert 'wifi' in agent.status.heals
        assert agent.status.heals['wifi'].last_result == 'ok'
        assert agent.status.heals['wifi'].count_today == 1
        mock_heal_wifi.assert_called_once()


class TestRunSingleCheck:
    def test_valid_check(self, phone_agent):
        with patch('fleet_agent.phone.health.check_wifi_connected', return_value=True):
            result = phone_agent.run_single_check('wifi')
            assert result is True

    def test_invalid_check_raises(self, phone_agent):
        import pytest
        with pytest.raises(ValueError, match='Unknown check'):
            phone_agent.run_single_check('nonexistent')


class TestRunSingleStep:
    def test_valid_step(self, phone_agent):
        with patch('fleet_agent.steps.screen.configure_screen') as mock:
            phone_agent.run_single_step('screen')
            mock.assert_called_once_with('TEST_SERIAL')

    def test_invalid_step_raises(self, phone_agent):
        import pytest
        with pytest.raises(ValueError, match='Unknown step'):
            phone_agent.run_single_step('nonexistent')


class TestSetupSteps:
    def test_all_expected_steps_listed(self):
        expected = [
            'configure_screen', 'configure_silent', 'provision_device_owner',
            'start_snapshot_server', 'setup_port_forwards', 'wait_for_server',
            'clear_passcode_if_set', 'connect_wifi',
            'allocate_and_pair_bluetooth', 'apply_restrictions', 'register',
        ]
        assert SETUP_STEPS == expected
