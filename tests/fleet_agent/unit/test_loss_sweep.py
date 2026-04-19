"""Unit tests for FleetAgent.loss_sweep — background loss detection."""

import sys
import threading
from unittest.mock import MagicMock, patch

# Mock dbus and gi before importing manager (they're Linux-only)
sys.modules.setdefault('dbus', MagicMock())
sys.modules.setdefault('dbus.mainloop.glib', MagicMock())
sys.modules.setdefault('dbus.service', MagicMock())
sys.modules.setdefault('gi', MagicMock())
sys.modules.setdefault('gi.repository', MagicMock())

from fleet_agent.manager import FleetAgent, LOSS_SWEEP_INTERVAL
from fleet_agent.loss_handler import LOSS_TIMEOUT_SECONDS


def _make_fleet_agent(now=0):
    """Create a FleetAgent with a controllable clock."""
    clock = MagicMock(return_value=now)
    with patch('fleet_agent.manager.PortAllocator'):
        fa = FleetAgent(time_fn=clock)
    fa._time_fn = clock
    return fa, clock


class TestLossSweep:
    @patch('fleet_agent.manager.handle_phone_lost')
    @patch('fleet_agent.manager.handle_dongle_lost')
    @patch('fleet_agent.manager.load_dongle_assignments', return_value={})
    @patch('fleet_agent.manager.enum_dongles', return_value={})
    def test_no_action_when_phones_recently_seen(
            self, _ed, _ld, mock_dongle_lost, mock_phone_lost):
        fa, clock = _make_fleet_agent(now=1000)
        # Phone seen 10s ago — well within timeout
        fa.phone_last_seen['SER001'] = 990
        fa._last_sweep = 0  # force sweep

        fa.loss_sweep()

        mock_phone_lost.assert_not_called()

    @patch('fleet_agent.manager.handle_phone_lost')
    @patch('fleet_agent.manager.handle_dongle_lost')
    @patch('fleet_agent.manager.load_dongle_assignments', return_value={})
    @patch('fleet_agent.manager.enum_dongles', return_value={})
    def test_triggers_phone_lost_after_timeout(
            self, _ed, _ld, mock_dongle_lost, mock_phone_lost):
        fa, clock = _make_fleet_agent(now=1000)
        # Phone last seen 301s ago — past timeout
        # Agent is already gone from self.agents (removed at T+6s by DISCONNECT_GRACE)
        # but phone_last_seen still has the stale timestamp
        fa.phone_last_seen['SER001'] = 1000 - LOSS_TIMEOUT_SECONDS - 1
        fa._last_sweep = 0

        fa.loss_sweep()

        mock_phone_lost.assert_called_once_with('SER001', fa)
        # last_seen should be cleared after loss
        assert 'SER001' not in fa.phone_last_seen

    @patch('fleet_agent.manager.handle_phone_lost')
    @patch('fleet_agent.manager.handle_dongle_lost')
    @patch('fleet_agent.manager.load_dongle_assignments', return_value={})
    @patch('fleet_agent.manager.enum_dongles', return_value={})
    def test_triggers_phone_lost_even_when_agent_already_removed(
            self, _ed, _ld, mock_dongle_lost, mock_phone_lost):
        """Key scenario: agent is removed at T+6s, loss fires at T+300s.
        The sweep must still trigger because phone_last_seen is independent
        of self.agents."""
        fa, clock = _make_fleet_agent(now=1000)
        # Agent already gone — but phone_last_seen still tracks it
        fa.phone_last_seen['SER001'] = 1000 - LOSS_TIMEOUT_SECONDS - 1
        assert 'SER001' not in fa.agents  # agent already cleaned up
        fa._last_sweep = 0

        fa.loss_sweep()

        mock_phone_lost.assert_called_once_with('SER001', fa)

    @patch('fleet_agent.manager.handle_phone_lost')
    @patch('fleet_agent.manager.handle_dongle_lost')
    @patch('fleet_agent.manager.load_dongle_assignments',
           return_value={'SER001': 'AA:BB:CC:DD:EE:01'})
    @patch('fleet_agent.manager.enum_dongles', return_value={})
    def test_triggers_dongle_lost_after_timeout(
            self, _ed, _ld, mock_dongle_lost, mock_phone_lost):
        fa, clock = _make_fleet_agent(now=1000)
        fa.dongle_last_seen['AA:BB:CC:DD:EE:01'] = 1000 - LOSS_TIMEOUT_SECONDS - 1
        fa._last_sweep = 0

        fa.loss_sweep()

        mock_dongle_lost.assert_called_once_with('AA:BB:CC:DD:EE:01', fa)
        assert 'AA:BB:CC:DD:EE:01' not in fa.dongle_last_seen

    @patch('fleet_agent.manager.handle_phone_lost')
    @patch('fleet_agent.manager.handle_dongle_lost')
    @patch('fleet_agent.manager.load_dongle_assignments', return_value={})
    @patch('fleet_agent.manager.enum_dongles', return_value={})
    def test_respects_sweep_interval(
            self, _ed, _ld, mock_dongle_lost, mock_phone_lost):
        fa, clock = _make_fleet_agent(now=1000)
        fa.phone_last_seen['SER001'] = 0  # way past timeout

        # Last sweep was 10s ago — too soon
        fa._last_sweep = 990

        fa.loss_sweep()

        mock_phone_lost.assert_not_called()

    @patch('fleet_agent.manager.handle_phone_lost')
    @patch('fleet_agent.manager.handle_dongle_lost')
    @patch('fleet_agent.manager.load_dongle_assignments', return_value={})
    @patch('fleet_agent.manager.enum_dongles', return_value={})
    def test_sweep_runs_after_interval_elapses(
            self, _ed, _ld, mock_dongle_lost, mock_phone_lost):
        fa, clock = _make_fleet_agent(now=1000)
        fa.phone_last_seen['SER001'] = 0

        # Last sweep was exactly LOSS_SWEEP_INTERVAL ago
        fa._last_sweep = 1000 - LOSS_SWEEP_INTERVAL - 1

        fa.loss_sweep()

        mock_phone_lost.assert_called_once()


class TestUpdateLastSeen:
    def test_updates_phone_last_seen(self):
        fa, clock = _make_fleet_agent(now=500)
        fa._update_last_seen({'SER001', 'SER002'})
        assert fa.phone_last_seen['SER001'] == 500
        assert fa.phone_last_seen['SER002'] == 500

    @patch('fleet_agent.manager.enum_dongles',
           return_value={'AA:BB:CC:DD:EE:01': 'hci0'})
    def test_updates_dongle_last_seen(self, _ed):
        fa, clock = _make_fleet_agent(now=500)
        fa._update_dongle_last_seen()
        assert fa.dongle_last_seen['AA:BB:CC:DD:EE:01'] == 500
