"""Unit tests for phone/health.py — health check logic with mocked I/O."""

import os
from unittest.mock import patch, MagicMock


class TestCheckBtBonded:
    def test_returns_false_when_no_adapter(self):
        from fleet_agent.phone.health import check_bt_bonded
        assert check_bt_bonded(None, '11:22:33:44:55:66') is False

    def test_returns_false_when_no_phone_mac(self):
        from fleet_agent.phone.health import check_bt_bonded
        assert check_bt_bonded('AA:BB:CC:DD:EE:01', None) is False

    def test_returns_true_when_paired(self):
        from fleet_agent.phone.health import check_bt_bonded
        mock_result = MagicMock(stdout='Paired: yes', stderr='', returncode=0)
        with patch('fleet_agent.phone.health.run_cmd', return_value=mock_result):
            assert check_bt_bonded('AA:BB:CC:DD:EE:01', '11:22:33:44:55:66') is True

    def test_returns_false_when_not_paired(self):
        from fleet_agent.phone.health import check_bt_bonded
        mock_result = MagicMock(stdout='Paired: no', stderr='', returncode=0)
        with patch('fleet_agent.phone.health.run_cmd', return_value=mock_result):
            assert check_bt_bonded('AA:BB:CC:DD:EE:01', '11:22:33:44:55:66') is False

    def test_returns_false_on_exception(self):
        from fleet_agent.phone.health import check_bt_bonded
        with patch('fleet_agent.phone.health.run_cmd', side_effect=Exception('fail')):
            assert check_bt_bonded('AA:BB:CC:DD:EE:01', '11:22:33:44:55:66') is False


class TestCheckBtConnected:
    def test_returns_false_when_no_adapter(self):
        from fleet_agent.phone.health import check_bt_connected
        assert check_bt_connected(None, '11:22:33:44:55:66') is False

    def test_returns_true_when_connected(self):
        from fleet_agent.phone.health import check_bt_connected
        mock_result = MagicMock(stdout='Connected: yes', stderr='', returncode=0)
        with patch('subprocess.run', return_value=mock_result):
            assert check_bt_connected('AA:BB:CC:DD:EE:01', '11:22:33:44:55:66') is True

    def test_returns_false_when_not_connected(self):
        from fleet_agent.phone.health import check_bt_connected
        mock_result = MagicMock(stdout='Connected: no', stderr='', returncode=0)
        with patch('subprocess.run', return_value=mock_result):
            assert check_bt_connected('AA:BB:CC:DD:EE:01', '11:22:33:44:55:66') is False


class TestCheckWifiConnected:
    def test_returns_true_when_no_ssid_configured(self):
        from fleet_agent.phone.health import check_wifi_connected
        with patch.dict(os.environ, {}, clear=True):
            # No WIFI_AP_SSID -> consider healthy
            assert check_wifi_connected('SERIAL') is True

    def test_returns_true_when_connected(self):
        from fleet_agent.phone.health import check_wifi_connected
        with patch.dict(os.environ, {'WIFI_AP_SSID': 'OtaconAP-1'}):
            with patch('fleet_agent.phone.health.adb_shell',
                       return_value='Wifi is connected'):
                assert check_wifi_connected('SERIAL') is True

    def test_returns_false_when_disconnected(self):
        from fleet_agent.phone.health import check_wifi_connected
        with patch.dict(os.environ, {'WIFI_AP_SSID': 'OtaconAP-1'}):
            with patch('fleet_agent.phone.health.adb_shell',
                       return_value='Wifi is disabled'):
                assert check_wifi_connected('SERIAL') is False


class TestCheckDeviceOwner:
    def test_returns_true_when_set(self):
        from fleet_agent.phone.health import check_device_owner
        with patch('fleet_agent.phone.health.adb_shell',
                   return_value='Device Owner: com.otacon.kiosk'):
            assert check_device_owner('SERIAL') is True

    def test_returns_false_when_not_set(self):
        from fleet_agent.phone.health import check_device_owner
        with patch('fleet_agent.phone.health.adb_shell',
                   return_value='No device owner'):
            assert check_device_owner('SERIAL') is False


class TestCheckRestrictions:
    FULL_RESTRICTIONS = (
        '  Device policy restrictions:\n'
        '    no_config_wifi\n'
        '    no_config_bluetooth\n'
        '    no_config_location\n'
        '    no_factory_reset\n'
        '    no_safe_boot\n'
        '    no_usb_file_transfer\n'
        '    no_airplane_mode\n'
        '    no_config_tethering\n'
    )

    def test_returns_true_when_all_restrictions_present(self):
        from fleet_agent.phone.health import check_restrictions
        with patch('fleet_agent.phone.health.adb_shell',
                   return_value=self.FULL_RESTRICTIONS):
            assert check_restrictions('SERIAL') is True

    def test_returns_false_when_restriction_missing(self):
        from fleet_agent.phone.health import check_restrictions
        partial = (
            '  Device policy restrictions:\n'
            '    no_config_wifi\n'
            '    no_config_location\n'
            '    no_factory_reset\n'
        )
        with patch('fleet_agent.phone.health.adb_shell', return_value=partial):
            assert check_restrictions('SERIAL') is False

    def test_returns_false_when_no_restrictions(self):
        from fleet_agent.phone.health import check_restrictions
        with patch('fleet_agent.phone.health.adb_shell',
                   return_value='User 0: admin'):
            assert check_restrictions('SERIAL') is False

    def test_returns_false_when_empty(self):
        from fleet_agent.phone.health import check_restrictions
        with patch('fleet_agent.phone.health.adb_shell', return_value=''):
            assert check_restrictions('SERIAL') is False

    def test_returns_false_when_device_policy_section_empty(self):
        """Pixel edge case: Device policy restrictions section exists but is empty."""
        from fleet_agent.phone.health import check_restrictions
        dumpsys = (
            '  Device policy restrictions:\n'
            '  Effective restrictions:\n'
            '    no_factory_reset\n'
        )
        with patch('fleet_agent.phone.health.adb_shell', return_value=dumpsys):
            assert check_restrictions('SERIAL') is False

    def test_ignores_effective_restrictions_section(self):
        """no_factory_reset in Effective but not Device policy must still fail."""
        from fleet_agent.phone.health import check_restrictions
        dumpsys = (
            '  Effective restrictions:\n'
            '    no_factory_reset\n'
            '    no_config_wifi\n'
            '    no_config_bluetooth\n'
            '    no_config_location\n'
            '    no_safe_boot\n'
            '    no_usb_file_transfer\n'
            '    no_airplane_mode\n'
            '    no_config_tethering\n'
        )
        with patch('fleet_agent.phone.health.adb_shell', return_value=dumpsys):
            assert check_restrictions('SERIAL') is False


class TestCheckSnapshotAlive:
    def test_returns_true_when_running(self):
        from fleet_agent.phone.health import check_snapshot_alive
        with patch('fleet_agent.phone.health.adb_shell', return_value='12345'):
            assert check_snapshot_alive('SERIAL') is True

    def test_returns_false_when_not_running(self):
        from fleet_agent.phone.health import check_snapshot_alive
        with patch('fleet_agent.phone.health.adb_shell', return_value=''):
            assert check_snapshot_alive('SERIAL') is False


class TestCheckPortForwards:
    def test_returns_true_when_both_present(self):
        from fleet_agent.phone.health import check_port_forwards
        with patch('fleet_agent.phone.health.adb',
                   side_effect=lambda s, *a, **kw:
                       'SERIAL tcp:9091 tcp:9091' if 'forward' in a
                       else 'SERIAL tcp:8081 tcp:8081'):
            assert check_port_forwards('SERIAL', 9091, 8081) is True

    def test_returns_false_when_forward_missing(self):
        from fleet_agent.phone.health import check_port_forwards
        with patch('fleet_agent.phone.health.adb',
                   side_effect=lambda s, *a, **kw:
                       '' if 'forward' in a
                       else 'SERIAL tcp:8081 tcp:8081'):
            assert check_port_forwards('SERIAL', 9091, 8081) is False
