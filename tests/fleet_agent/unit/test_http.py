"""Unit tests for util/http.py — HTTP helper logic."""

import json
from unittest.mock import patch, MagicMock
from urllib.error import URLError

from fleet_agent.util.http import http_get, http_post


class TestHttpGet:
    def test_returns_parsed_json(self):
        body = json.dumps({'ok': True}).encode()
        mock_resp = MagicMock()
        mock_resp.read.return_value = body
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        with patch('fleet_agent.util.http.urlopen', return_value=mock_resp):
            result = http_get('http://localhost/test')
        assert result == {'ok': True}

    def test_returns_string_on_non_json(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = b'plain text'
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        with patch('fleet_agent.util.http.urlopen', return_value=mock_resp):
            result = http_get('http://localhost/test')
        assert result == 'plain text'

    def test_returns_none_on_error(self):
        with patch('fleet_agent.util.http.urlopen', side_effect=URLError('fail')):
            result = http_get('http://localhost/test')
        assert result is None

    def test_returns_none_on_timeout(self):
        with patch('fleet_agent.util.http.urlopen', side_effect=TimeoutError):
            result = http_get('http://localhost/test')
        assert result is None


class TestHttpPost:
    def test_returns_parsed_json(self):
        body = json.dumps({'id': 'phone-123'}).encode()
        mock_resp = MagicMock()
        mock_resp.read.return_value = body
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        with patch('fleet_agent.util.http.urlopen', return_value=mock_resp):
            result = http_post('http://localhost/test', {'key': 'value'})
        assert result == {'id': 'phone-123'}

    def test_returns_none_on_error(self):
        with patch('fleet_agent.util.http.urlopen', side_effect=URLError('fail')):
            result = http_post('http://localhost/test', {})
        assert result is None
