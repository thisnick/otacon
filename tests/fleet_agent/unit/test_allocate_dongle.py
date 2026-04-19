"""Unit tests for allocate_dongle replaced_mac return value."""

from unittest.mock import patch, MagicMock

import fleet_agent.bluetooth.dongle as dongle_mod
from fleet_agent.bluetooth.dongle import allocate_dongle


class TestAllocateDongleReplacedMac:
    def setup_method(self):
        # Reset module-level cache between tests
        dongle_mod._dongle_cache = None
        dongle_mod._bt_mac_cache = {}

    @patch('fleet_agent.bluetooth.dongle.enum_dongles',
           return_value={'AA:BB:CC:DD:EE:01': 'hci0'})
    @patch('fleet_agent.bluetooth.dongle.save_dongle_assignment')
    @patch('fleet_agent.bluetooth.dongle.PHONES_JSON_PATH', '/nonexistent/phones.json')
    def test_fresh_assignment_returns_none_replaced(self, mock_save, mock_enum):
        """First-time assignment: no saved dongle, replaced_mac is None."""
        result = allocate_dongle('SER001')
        assert result is not None
        mac, hci, replaced = result
        assert mac == 'AA:BB:CC:DD:EE:01'
        assert hci == 'hci0'
        assert replaced is None

    @patch('fleet_agent.bluetooth.dongle.enum_dongles',
           return_value={'AA:BB:CC:DD:EE:01': 'hci0'})
    @patch('fleet_agent.bluetooth.dongle.save_dongle_assignment')
    @patch('fleet_agent.bluetooth.dongle.PHONES_JSON_PATH', '/nonexistent/phones.json')
    def test_reuse_saved_dongle_returns_none_replaced(self, mock_save, mock_enum):
        """Saved dongle still present: no reassignment, replaced_mac is None."""
        dongle_mod._dongle_cache = {'SER001': 'AA:BB:CC:DD:EE:01'}
        result = allocate_dongle('SER001')
        assert result is not None
        mac, hci, replaced = result
        assert mac == 'AA:BB:CC:DD:EE:01'
        assert replaced is None

    @patch('fleet_agent.bluetooth.dongle.enum_dongles',
           return_value={'FF:FF:FF:FF:FF:01': 'hci1'})
    @patch('fleet_agent.bluetooth.dongle.save_dongle_assignment')
    @patch('fleet_agent.bluetooth.dongle.PHONES_JSON_PATH', '/nonexistent/phones.json')
    def test_missing_saved_dongle_returns_replaced_mac(self, mock_save, mock_enum):
        """Saved dongle gone, new one assigned: replaced_mac is the old MAC."""
        dongle_mod._dongle_cache = {'SER001': 'AA:BB:CC:DD:EE:01'}
        result = allocate_dongle('SER001')
        assert result is not None
        mac, hci, replaced = result
        assert mac == 'FF:FF:FF:FF:FF:01'
        assert hci == 'hci1'
        assert replaced == 'AA:BB:CC:DD:EE:01'
