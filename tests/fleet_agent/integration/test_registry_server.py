"""Integration tests for registry/server.py — Rust server registration."""

import os
from unittest.mock import patch, MagicMock
from urllib.error import URLError

from fleet_agent.registry.server import register_with_server, deregister_from_server


class TestRegisterWithServer:
    def test_sends_registration_payload(self):
        with patch('fleet_agent.registry.server.http_post',
                   return_value={'id': 'phone-abc'}) as mock:
            phone_id = register_with_server('S1', 9091, 8081,
                                             adapter_mac='AA:BB', phone_bt_mac='11:22')
        assert phone_id == 'phone-abc'
        payload = mock.call_args[0][1]
        assert payload['adb_serial'] == 'S1'
        assert payload['snapshot_port'] == 9091
        assert payload['adapter_mac'] == 'AA:BB'

    def test_returns_none_on_failure(self):
        with patch('fleet_agent.registry.server.http_post', return_value=None):
            phone_id = register_with_server('S1', 9091, 8081)
        assert phone_id is None

    def test_omits_optional_fields(self):
        with patch('fleet_agent.registry.server.http_post',
                   return_value={'id': 'phone-abc'}) as mock:
            register_with_server('S1', 9091, 8081)
        payload = mock.call_args[0][1]
        assert 'adapter_mac' not in payload
        assert 'phone_bt_mac' not in payload


class TestDeregisterFromServer:
    def test_noop_when_no_phone_id(self):
        with patch('fleet_agent.registry.server.urlopen') as mock:
            deregister_from_server(None)
        mock.assert_not_called()

    def test_sends_delete(self):
        with patch('fleet_agent.registry.server.urlopen') as mock:
            deregister_from_server('phone-abc')
        mock.assert_called_once()
        req = mock.call_args[0][0]
        assert req.method == 'DELETE'
        assert 'phone-abc' in req.full_url

    def test_swallows_errors(self):
        with patch('fleet_agent.registry.server.urlopen',
                   side_effect=URLError('fail')):
            deregister_from_server('phone-abc')  # should not raise
