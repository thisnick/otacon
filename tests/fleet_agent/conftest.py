"""Shared fixtures for fleet_agent tests.

Unit tests use pure mocks (no subprocess, no filesystem, no network).
Integration tests use subprocess/filesystem mocks via these fixtures.
Hardware tests run against live Pi + phones -- no mocking.
"""

import os
import sys
import json
import pytest
from dataclasses import asdict
from unittest.mock import MagicMock, patch

# Ensure fleet_agent package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))


# ---------------------------------------------------------------------------
# Unit-level fixtures (pure Python, no I/O)
# ---------------------------------------------------------------------------

@pytest.fixture
def monitor_status():
    """A fresh MonitorStatus for testing."""
    from fleet_agent.phone.status import MonitorStatus
    return MonitorStatus()


@pytest.fixture
def step_status():
    """A fresh StepStatus for testing."""
    from fleet_agent.phone.status import StepStatus
    return StepStatus()


@pytest.fixture
def heal_status():
    """A fresh HealStatus for testing."""
    from fleet_agent.phone.status import HealStatus
    return HealStatus()


@pytest.fixture
def phone_agent():
    """A PhoneAgent with mocked external calls for unit testing."""
    from fleet_agent.phone.agent import PhoneAgent
    agent = PhoneAgent(
        serial='TEST_SERIAL',
        snapshot_port=9091,
        internal_port=8081,
        display_num=50,
        vnc_port=5900,
    )
    agent.adapter_mac = 'AA:BB:CC:DD:EE:01'
    agent.adapter_hci = 'hci0'
    agent.phone_bt_mac = '11:22:33:44:55:66'
    agent.phone_id = 'phone-test'
    agent.registry_id = 'reg-test'
    return agent


# ---------------------------------------------------------------------------
# Integration-level fixtures (mock subprocess + filesystem + network)
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_adb():
    """Patch adb and adb_shell to return configurable responses."""
    responses = {}

    def fake_adb(serial, *args, timeout=10):
        key = ' '.join(args)
        return responses.get(key, '')

    def fake_adb_shell(serial, cmd, timeout=10):
        return responses.get(cmd, '')

    with patch('fleet_agent.util.adb.subprocess.run') as mock_run:
        mock_run.return_value = MagicMock(
            stdout='',
            stderr='',
            returncode=0,
        )
        yield responses, mock_run


@pytest.fixture
def mock_http():
    """Patch http_get and http_post."""
    get_responses = {}
    post_responses = {}

    def fake_get(url, timeout=5):
        return get_responses.get(url)

    def fake_post(url, data, timeout=5):
        return post_responses.get(url)

    with patch('fleet_agent.util.http.urlopen') as mock_urlopen:
        yield get_responses, post_responses, mock_urlopen


@pytest.fixture
def phones_json(tmp_path):
    """Create a temporary phones.json with sample data."""
    phones = [
        {
            'adb_serial': 'R92X1022ABC',
            'snapshot_port': 9091,
            'internal_port': 8081,
            'display_num': 50,
            'vnc_port': 5900,
            'adapter_mac': 'AA:BB:CC:DD:EE:01',
            'phone_bt_mac': '11:22:33:44:55:01',
        },
        {
            'adb_serial': 'R5CT60SDGKD',
            'snapshot_port': 9092,
            'internal_port': 8082,
            'display_num': 51,
            'vnc_port': 5901,
            'adapter_mac': 'AA:BB:CC:DD:EE:02',
            'phone_bt_mac': '11:22:33:44:55:02',
        },
        {
            'adb_serial': '14151JECABC',
            'snapshot_port': 9093,
            'internal_port': 8083,
            'display_num': 52,
            'vnc_port': 5902,
            'adapter_mac': 'AA:BB:CC:DD:EE:03',
            'phone_bt_mac': '11:22:33:44:55:03',
        },
    ]
    path = tmp_path / 'phones.json'
    path.write_text(json.dumps(phones, indent=2))
    return str(path)
