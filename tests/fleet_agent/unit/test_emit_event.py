"""Unit tests for registry/client.py — emit_event."""

from unittest.mock import patch, call

from fleet_agent.registry.client import emit_event


class TestEmitEvent:
    @patch('fleet_agent.registry.client.http_post')
    @patch.dict('os.environ', {'REGISTRY_URL': 'http://registry:8080',
                                'HOST_ID': 'pi-01'})
    def test_posts_to_registry(self, mock_post):
        emit_event('phone.lost', {'serial': 'SER001', 'phone_id': 'p1'})

        mock_post.assert_called_once_with(
            'http://registry:8080/api/v1/events',
            {
                'host_id': 'pi-01',
                'phone_id': 'p1',
                'severity': 'info',
                'category': 'phone.lost',
                'message': 'phone.lost event',
                'data': {'serial': 'SER001', 'phone_id': 'p1'},
            },
        )

    @patch('fleet_agent.registry.client.http_post')
    @patch.dict('os.environ', {}, clear=True)
    def test_no_registry_url_does_not_crash(self, mock_post):
        # Should just log, not crash
        emit_event('phone.lost', {'serial': 'SER001'})
        mock_post.assert_not_called()

    @patch('fleet_agent.registry.client.http_post')
    @patch.dict('os.environ', {'REGISTRY_URL': 'http://registry:8080',
                                'HOST_ID': 'pi-01'})
    def test_none_data_handled(self, mock_post):
        emit_event('dongle.lost', None)
        mock_post.assert_called_once()
        payload = mock_post.call_args[0][1]
        assert payload['phone_id'] is None
        assert 'data' not in payload
