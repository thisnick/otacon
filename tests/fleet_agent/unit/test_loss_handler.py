"""Unit tests for loss_handler.py — phone/dongle loss detection and recovery."""

import threading
from unittest.mock import MagicMock, patch, call

from fleet_agent.loss_handler import (
    LOSS_TIMEOUT_SECONDS,
    handle_phone_lost,
    handle_dongle_lost,
)
from fleet_agent.phone.agent import PhoneAgent


def _make_agent(serial='SER001', adapter_mac='AA:BB:CC:DD:EE:01',
                phone_id='phone-1', registry_id='reg-1'):
    agent = MagicMock(spec=PhoneAgent)
    agent.serial = serial
    agent.adapter_mac = adapter_mac
    agent.phone_id = phone_id
    agent.registry_id = registry_id
    agent.snapshot_port = 9091
    agent.phone_bt_mac = '11:22:33:44:55:01'
    return agent


def _make_fleet_agent(agents_dict=None):
    fa = MagicMock()
    fa._lock = threading.Lock()
    fa.agents = agents_dict or {}
    fa.port_allocator = MagicMock()
    return fa


class TestLossTimeout:
    def test_timeout_is_300_seconds(self):
        assert LOSS_TIMEOUT_SECONDS == 300


class TestHandlePhoneLost:
    @patch('fleet_agent.loss_handler.emit_event')
    def test_stops_agent_and_frees_dongle(self, mock_emit):
        agent = _make_agent()
        thread = MagicMock()
        fa = _make_fleet_agent({'SER001': (agent, thread)})

        handle_phone_lost('SER001', fa)

        agent.stop.assert_called_once()
        fa.port_allocator.release.assert_called_once_with(9091)
        fa.port_allocator.release_dongle.assert_called_once_with('AA:BB:CC:DD:EE:01')

    @patch('fleet_agent.loss_handler.emit_event')
    def test_emits_phone_lost_event(self, mock_emit):
        agent = _make_agent()
        thread = MagicMock()
        fa = _make_fleet_agent({'SER001': (agent, thread)})

        handle_phone_lost('SER001', fa)

        mock_emit.assert_called_once_with('phone.lost', {
            'serial': 'SER001',
            'phone_id': 'phone-1',
            'adapter_mac': 'AA:BB:CC:DD:EE:01',
        })

    @patch('fleet_agent.loss_handler.emit_event')
    def test_removes_agent_from_fleet(self, mock_emit):
        agent = _make_agent()
        thread = MagicMock()
        fa = _make_fleet_agent({'SER001': (agent, thread)})

        handle_phone_lost('SER001', fa)

        assert 'SER001' not in fa.agents

    @patch('fleet_agent.loss_handler.emit_event')
    def test_handles_missing_agent_gracefully(self, mock_emit):
        fa = _make_fleet_agent({})
        handle_phone_lost('SER_GONE', fa)
        # Should not raise, just log warning
        mock_emit.assert_not_called()

    @patch('fleet_agent.loss_handler.emit_event')
    def test_skips_dongle_release_when_no_adapter(self, mock_emit):
        agent = _make_agent(adapter_mac=None)
        thread = MagicMock()
        fa = _make_fleet_agent({'SER001': (agent, thread)})

        handle_phone_lost('SER001', fa)

        fa.port_allocator.release_dongle.assert_not_called()


class TestHandleDongleLost:
    @patch('fleet_agent.loss_handler.save_dongle_assignment')
    @patch('fleet_agent.loss_handler.emit_event')
    def test_reassigns_orphan_to_spare(self, mock_emit, mock_save):
        agent = _make_agent(serial='SER001', adapter_mac='AA:BB:CC:DD:EE:01')
        thread = MagicMock()
        fa = _make_fleet_agent({'SER001': (agent, thread)})
        fa.port_allocator.claim_spare_dongle.return_value = 'FF:FF:FF:FF:FF:01'

        handle_dongle_lost('AA:BB:CC:DD:EE:01', fa)

        fa.port_allocator.claim_spare_dongle.assert_called_once_with('SER001')
        assert agent.adapter_mac == 'FF:FF:FF:FF:FF:01'
        assert agent.phone_bt_mac is None  # cleared for re-pair
        mock_save.assert_called_once_with('SER001', 'FF:FF:FF:FF:FF:01')
        agent._run_heal.assert_called_once_with('bt_bonded')

    @patch('fleet_agent.loss_handler.save_dongle_assignment')
    @patch('fleet_agent.loss_handler.emit_event')
    def test_emits_dongle_lost_and_reassigned_events(self, mock_emit, mock_save):
        agent = _make_agent(serial='SER001', adapter_mac='AA:BB:CC:DD:EE:01')
        thread = MagicMock()
        fa = _make_fleet_agent({'SER001': (agent, thread)})
        fa.port_allocator.claim_spare_dongle.return_value = 'FF:FF:FF:FF:FF:01'

        handle_dongle_lost('AA:BB:CC:DD:EE:01', fa)

        calls = mock_emit.call_args_list
        assert len(calls) == 2
        assert calls[0] == call('dongle.lost', {
            'adapter_mac': 'AA:BB:CC:DD:EE:01',
            'orphan_serial': 'SER001',
            'phone_id': 'phone-1',
        })
        assert calls[1] == call('phone.reassigned', {
            'serial': 'SER001',
            'phone_id': 'phone-1',
            'old_adapter_mac': 'AA:BB:CC:DD:EE:01',
            'new_adapter_mac': 'FF:FF:FF:FF:FF:01',
        })

    @patch('fleet_agent.loss_handler.emit_event')
    def test_no_spare_available(self, mock_emit):
        agent = _make_agent(serial='SER001', adapter_mac='AA:BB:CC:DD:EE:01')
        thread = MagicMock()
        fa = _make_fleet_agent({'SER001': (agent, thread)})
        fa.port_allocator.claim_spare_dongle.return_value = None

        handle_dongle_lost('AA:BB:CC:DD:EE:01', fa)

        # Agent should still have old MAC (no reassignment happened)
        assert agent.adapter_mac == 'AA:BB:CC:DD:EE:01'
        agent._run_heal.assert_not_called()

    @patch('fleet_agent.loss_handler.emit_event')
    def test_no_phone_using_dongle(self, mock_emit):
        fa = _make_fleet_agent({})

        handle_dongle_lost('AA:BB:CC:DD:EE:99', fa)

        mock_emit.assert_called_once_with('dongle.lost', {
            'adapter_mac': 'AA:BB:CC:DD:EE:99',
            'orphan_serial': None,
        })
