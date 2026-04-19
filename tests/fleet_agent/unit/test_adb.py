"""Unit tests for util/adb.py — ADB helper logic."""

from unittest.mock import patch, MagicMock
import subprocess

from fleet_agent.util.adb import adb, adb_shell, get_connected_serials


class TestAdb:
    def test_returns_stdout(self):
        mock_result = MagicMock(stdout='  some output  ', stderr='', returncode=0)
        with patch('subprocess.run', return_value=mock_result) as m:
            out = adb('SERIAL_A', 'get-state')
            assert out == 'some output'

    def test_timeout_returns_empty(self):
        with patch('subprocess.run',
                   side_effect=subprocess.TimeoutExpired('adb', 10)):
            out = adb('SERIAL_A', 'get-state')
            assert out == ''

    def test_file_not_found_returns_empty(self):
        with patch('subprocess.run',
                   side_effect=FileNotFoundError):
            out = adb('SERIAL_A', 'get-state')
            assert out == ''


class TestAdbShell:
    def test_delegates_to_adb(self):
        mock_result = MagicMock(stdout='device', stderr='', returncode=0)
        with patch('subprocess.run', return_value=mock_result):
            out = adb_shell('SERIAL_A', 'getprop ro.product.model')
            assert out == 'device'


class TestGetConnectedSerials:
    def test_parses_device_list(self):
        mock_result = MagicMock(
            stdout='List of devices attached\nSERIAL_A\tdevice\nSERIAL_B\tdevice\n',
            returncode=0,
        )
        with patch('subprocess.run', return_value=mock_result):
            serials = get_connected_serials()
            assert serials == {'SERIAL_A', 'SERIAL_B'}

    def test_ignores_unauthorized(self):
        mock_result = MagicMock(
            stdout='List of devices attached\nSERIAL_A\tdevice\nSERIAL_B\tunauthorized\n',
            returncode=0,
        )
        with patch('subprocess.run', return_value=mock_result):
            serials = get_connected_serials()
            assert serials == {'SERIAL_A'}

    def test_empty_on_timeout(self):
        with patch('subprocess.run',
                   side_effect=subprocess.TimeoutExpired('adb', 5)):
            serials = get_connected_serials()
            assert serials == set()

    def test_empty_on_no_devices(self):
        mock_result = MagicMock(
            stdout='List of devices attached\n\n',
            returncode=0,
        )
        with patch('subprocess.run', return_value=mock_result):
            serials = get_connected_serials()
            assert serials == set()
