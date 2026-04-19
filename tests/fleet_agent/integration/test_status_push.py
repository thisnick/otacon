"""Integration tests for status push — verifying the event payload format."""

import json
from unittest.mock import patch, MagicMock

from fleet_agent.phone.status import (
    MonitorStatus, StepStatus, HealStatus, push_status, now_iso,
)


class TestPushStatus:
    def test_sends_correct_payload(self):
        status = MonitorStatus(
            phase='monitoring',
            loop_iteration=5,
            last_check_at=now_iso(),
        )
        status.setup['screen'] = StepStatus(attempted=True, succeeded=True)
        status.health['wifi'] = True
        status.heals['wifi'] = HealStatus(count_today=1, last_result='ok')

        with patch('fleet_agent.phone.status.urlopen') as mock_urlopen:
            mock_urlopen.return_value.__enter__ = MagicMock()
            mock_urlopen.return_value.__exit__ = MagicMock(return_value=False)
            push_status(status, 'phone-test', 8081)

        mock_urlopen.assert_called_once()
        req = mock_urlopen.call_args[0][0]
        payload = json.loads(req.data.decode())

        assert '/phones/phone-test/api/internal/event' in req.full_url
        assert payload['event'] == 'monitor_status'
        assert payload['data']['phone_id'] == 'phone-test'
        data = payload['data']['status']
        assert data['phase'] == 'monitoring'
        assert data['loop_iteration'] == 5
        assert data['setup']['screen']['succeeded'] is True
        assert data['health']['wifi'] is True
        assert data['heals']['wifi']['count_today'] == 1

    def test_skips_when_no_phone_id(self):
        """push_status is a no-op when phone_id is None."""
        status = MonitorStatus()
        with patch('fleet_agent.phone.status.urlopen') as mock_urlopen:
            push_status(status, None, 8081)
        mock_urlopen.assert_not_called()

    def test_all_required_fields_present(self):
        status = MonitorStatus()
        with patch('fleet_agent.phone.status.urlopen') as mock_urlopen:
            mock_urlopen.return_value.__enter__ = MagicMock()
            mock_urlopen.return_value.__exit__ = MagicMock(return_value=False)
            push_status(status, 'p', 8081)
        req = mock_urlopen.call_args[0][0]
        data = json.loads(req.data.decode())['data']['status']
        required = ['phase', 'setup', 'health', 'heals', 'loop_iteration', 'last_check_at']
        for field in required:
            assert field in data, f'Missing required field: {field}'
