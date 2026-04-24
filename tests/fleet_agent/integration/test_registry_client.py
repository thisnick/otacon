"""Integration tests for registry/client.py — registry HTTP interactions."""

import os
from unittest.mock import patch, MagicMock

from fleet_agent.registry.client import (
    register_with_registry, deregister_from_registry, report_error,
)


class TestRegisterWithRegistry:
    def test_returns_none_when_no_url(self):
        with patch.dict(os.environ, {}, clear=True):
            rid, config = register_with_registry({'adb_serial': 'S1'})
        assert rid is None
        assert config is None

    def test_sends_identity_and_adapter(self):
        with patch.dict(os.environ, {'REGISTRY_URL': 'http://reg:8080', 'HOST_ID': 'pi-1'}):
            with patch('fleet_agent.registry.client.http_post',
                       return_value={'phone_id': 'r-123', 'config': {'bluetooth_enabled': True}}) as mock:
                rid, config = register_with_registry(
                    {'adb_serial': 'S1', 'model': 'Pixel'},
                    adapter_mac='AA:BB:CC:DD:EE:01')
        assert rid == 'r-123'
        assert config == {'bluetooth_enabled': True}
        payload = mock.call_args[0][1]
        assert payload['host_id'] == 'pi-1'
        assert payload['adb_serial'] == 'S1'
        assert payload['adapter_mac'] == 'AA:BB:CC:DD:EE:01'

    def test_returns_none_on_failure(self):
        with patch.dict(os.environ, {'REGISTRY_URL': 'http://reg:8080'}):
            with patch('fleet_agent.registry.client.http_post', return_value=None):
                rid, config = register_with_registry({'adb_serial': 'S1'})
        assert rid is None
        assert config is None


class TestDeregisterFromRegistry:
    def test_noop_when_no_url(self):
        with patch.dict(os.environ, {}, clear=True):
            with patch('fleet_agent.registry.client.http_post') as mock:
                deregister_from_registry('r-123')
        mock.assert_not_called()

    def test_noop_when_no_id(self):
        with patch.dict(os.environ, {'REGISTRY_URL': 'http://reg:8080'}):
            with patch('fleet_agent.registry.client.http_post') as mock:
                deregister_from_registry(None)
        mock.assert_not_called()

    def test_sends_deregister(self):
        with patch.dict(os.environ, {'REGISTRY_URL': 'http://reg:8080', 'HOST_ID': 'pi-1'}):
            with patch('fleet_agent.registry.client.http_post') as mock:
                deregister_from_registry('r-123')
        mock.assert_called_once()
        payload = mock.call_args[0][1]
        assert payload['phone_id'] == 'r-123'


class TestReportError:
    def test_posts_to_registry(self):
        with patch.dict(os.environ, {'REGISTRY_URL': 'http://reg:8080', 'HOST_ID': 'pi-1'}):
            with patch('fleet_agent.registry.client.http_post') as mock:
                report_error('bluetooth.fail', 'pair failed', phone_id='r-123')
        payload = mock.call_args[0][1]
        assert payload['category'] == 'bluetooth.fail'
        assert payload['message'] == 'pair failed'
        assert payload['severity'] == 'error'

    def test_logs_when_no_registry(self):
        with patch.dict(os.environ, {}, clear=True):
            with patch('fleet_agent.registry.client.http_post') as mock:
                report_error('test', 'msg')
        mock.assert_not_called()
