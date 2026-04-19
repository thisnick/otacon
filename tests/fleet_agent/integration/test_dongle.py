"""Integration tests for bluetooth/dongle.py — dongle enumeration and allocation."""

import json
from unittest.mock import patch, MagicMock

from fleet_agent.bluetooth.dongle import enum_dongles


class TestEnumDongles:
    def test_parses_hciconfig_output(self):
        hciconfig_output = (
            "hci0:\tType: Primary  Bus: USB\n"
            "\tBD Address: AA:BB:CC:DD:EE:01  ACL MTU: 1021:8  SCO MTU: 64:1\n"
            "\tUP RUNNING PSCAN ISCAN\n"
            "\n"
            "hci1:\tType: Primary  Bus: USB\n"
            "\tBD Address: AA:BB:CC:DD:EE:02  ACL MTU: 1021:8  SCO MTU: 64:1\n"
            "\tUP RUNNING PSCAN ISCAN\n"
        )
        mock_result = MagicMock(stdout=hciconfig_output, returncode=0)
        with patch('subprocess.run', return_value=mock_result):
            dongles = enum_dongles()
        assert dongles == {
            'AA:BB:CC:DD:EE:01': 'hci0',
            'AA:BB:CC:DD:EE:02': 'hci1',
        }

    def test_ignores_zero_address(self):
        output = (
            "hci0:\tType: Primary  Bus: USB\n"
            "\tBD Address: 00:00:00:00:00:00  ACL MTU: 1021:8\n"
        )
        mock_result = MagicMock(stdout=output, returncode=0)
        with patch('subprocess.run', return_value=mock_result):
            dongles = enum_dongles()
        assert dongles == {}

    def test_returns_empty_on_timeout(self):
        import subprocess
        with patch('subprocess.run',
                   side_effect=subprocess.TimeoutExpired('hciconfig', 5)):
            dongles = enum_dongles()
        assert dongles == {}

    def test_returns_empty_on_file_not_found(self):
        with patch('subprocess.run', side_effect=FileNotFoundError):
            dongles = enum_dongles()
        assert dongles == {}
