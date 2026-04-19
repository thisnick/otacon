"""Unit tests for registry/identity.py — identity gathering logic."""

from unittest.mock import patch


class TestGatherIdentity:
    def test_gathers_all_fields(self):
        from fleet_agent.registry.identity import gather_identity
        responses = {
            'getprop ro.product.model': 'SM-S901U',
            'settings get secure bluetooth_address': 'AA:BB:CC:DD:EE:FF',
            ("service call iphonesubinfo 1 | grep -o '[0-9a-f]\\{8\\}' | tail -n+2 | "
             "while read a; do echo -n \"\\u${a:4:4}\\u${a:0:4}\"; done"):
                '123456789012345',
            ("content query --uri content://com.otacon.kiosk/device/phone-number "
             "2>/dev/null | grep -o 'number=.*' | cut -d= -f2"):
                '+15551234567',
        }
        with patch('fleet_agent.registry.identity.adb_shell',
                   side_effect=lambda s, cmd, **kw: responses.get(cmd, '')):
            identity = gather_identity('SERIAL_A')
        assert identity['adb_serial'] == 'SERIAL_A'
        assert identity['model'] == 'SM-S901U'
        assert identity['bt_mac'] == 'AA:BB:CC:DD:EE:FF'
        assert identity['imei'] == '123456789012345'
        assert identity['phone_number'] == '+15551234567'

    def test_null_bt_mac_becomes_none(self):
        from fleet_agent.registry.identity import gather_identity
        with patch('fleet_agent.registry.identity.adb_shell', return_value='null'):
            identity = gather_identity('SERIAL_A')
        assert identity['bt_mac'] is None

    def test_empty_fields_become_none(self):
        from fleet_agent.registry.identity import gather_identity
        with patch('fleet_agent.registry.identity.adb_shell', return_value=''):
            identity = gather_identity('SERIAL_A')
        assert identity['model'] is None
        assert identity['bt_mac'] is None
        assert identity['imei'] is None
        assert identity['phone_number'] is None

    def test_short_imei_becomes_none(self):
        from fleet_agent.registry.identity import gather_identity
        responses = {
            'getprop ro.product.model': 'Pixel',
            'settings get secure bluetooth_address': 'null',
        }
        with patch('fleet_agent.registry.identity.adb_shell',
                   side_effect=lambda s, cmd, **kw: responses.get(cmd, '123')):
            identity = gather_identity('SERIAL_A')
        # IMEI < 14 chars should be None
        assert identity['imei'] is None
