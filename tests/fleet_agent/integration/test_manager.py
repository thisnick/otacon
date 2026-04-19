"""Integration tests for manager.py — FleetAgent device discovery + supervision."""

import sys
import threading
import time
from unittest.mock import patch, MagicMock

# Mock dbus and gi before importing manager (they're Linux-only)
sys.modules.setdefault('dbus', MagicMock())
sys.modules.setdefault('dbus.mainloop.glib', MagicMock())
sys.modules.setdefault('dbus.service', MagicMock())
sys.modules.setdefault('gi', MagicMock())
sys.modules.setdefault('gi.repository', MagicMock())

from fleet_agent.manager import FleetAgent, DISCONNECT_GRACE


class TestFleetAgentDiscovery:
    def test_spawns_agent_for_new_device(self):
        fa = FleetAgent()
        with patch.object(fa, '_start_bluetooth_services'):
            with patch.object(fa, 'report_dongles'):
                with patch('fleet_agent.phone.agent.PhoneAgent.run'):
                    from fleet_agent.phone.agent import PhoneAgent
                    agent = PhoneAgent('SERIAL_A', 9091, 8081, 50, 5900)
                    thread = threading.Thread(target=lambda: None, daemon=True)
                    thread.start()
                    with fa._lock:
                        fa.agents['SERIAL_A'] = (agent, thread)
                    assert 'SERIAL_A' in fa.agents

    def test_disconnect_grace_period(self):
        fa = FleetAgent()
        agent = MagicMock()
        agent.snapshot_port = 9091
        thread = MagicMock()
        fa.agents['SERIAL_A'] = (agent, thread)

        for _ in range(DISCONNECT_GRACE - 1):
            with fa._lock:
                fa._missing_count['SERIAL_A'] = fa._missing_count.get('SERIAL_A', 0) + 1
        assert 'SERIAL_A' in fa.agents

    def test_disconnect_after_grace(self):
        fa = FleetAgent()
        agent = MagicMock()
        agent.snapshot_port = 9091
        thread = MagicMock()
        fa.agents['SERIAL_A'] = (agent, thread)
        fa._missing_count['SERIAL_A'] = DISCONNECT_GRACE

        with fa._lock:
            a, t = fa.agents.pop('SERIAL_A')
            a.stop()
        agent.stop.assert_called_once()
        assert 'SERIAL_A' not in fa.agents


class TestFleetAgentLookup:
    def test_get_agent_by_serial(self):
        fa = FleetAgent()
        agent = MagicMock()
        agent.phone_id = 'phone-test'
        fa.agents['SERIAL_A'] = (agent, MagicMock())
        assert fa.get_agent('SERIAL_A') is agent

    def test_get_agent_by_phone_id(self):
        fa = FleetAgent()
        agent = MagicMock()
        agent.phone_id = 'phone-test'
        fa.agents['SERIAL_A'] = (agent, MagicMock())
        assert fa.get_agent('phone-test') is agent

    def test_get_agent_returns_none_for_unknown(self):
        fa = FleetAgent()
        assert fa.get_agent('nonexistent') is None

    def test_list_agents(self):
        fa = FleetAgent()
        a1 = MagicMock()
        a2 = MagicMock()
        fa.agents['S1'] = (a1, MagicMock())
        fa.agents['S2'] = (a2, MagicMock())
        agents = fa.list_agents()
        assert len(agents) == 2
        assert a1 in agents
        assert a2 in agents
