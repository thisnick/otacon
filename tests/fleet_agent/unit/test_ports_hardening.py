"""Unit tests for PortAllocator hardening and dongle pool methods."""

import json
import pytest
from unittest.mock import patch

from fleet_agent.util.ports import PortAllocator


class TestPortAllocatorHardening:
    """Reject empty or test-pattern serials (defense in depth)."""

    def test_rejects_empty_serial(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            with pytest.raises(ValueError, match='empty serial'):
                alloc.allocate('')

    def test_rejects_test_serial(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            with pytest.raises(ValueError, match='test/fake serial'):
                alloc.allocate('TEST')

    def test_rejects_fake_serial(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            with pytest.raises(ValueError, match='test/fake serial'):
                alloc.allocate('FAKE')

    def test_rejects_phantom_serial(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            with pytest.raises(ValueError, match='test/fake serial'):
                alloc.allocate('PHANTOM')

    def test_rejects_serial_ending_in_abc(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            with pytest.raises(ValueError, match='test/fake serial'):
                alloc.allocate('14151JECABC')

    def test_allows_real_serial(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            sp, ip, dn, vp = alloc.allocate('R92X1022S7K')
            assert sp == 9091  # first index

    def test_case_insensitive_rejection(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            with pytest.raises(ValueError):
                alloc.allocate('test')
            with pytest.raises(ValueError):
                alloc.allocate('fake')


class TestReleaseDongle:
    def test_clears_adapter_mac_in_json(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        phones = [{
            'adb_serial': 'SER001',
            'snapshot_port': 9091,
            'adapter_mac': 'AA:BB:CC:DD:EE:01',
            'phone_bt_mac': '11:22:33:44:55:01',
        }]
        with open(path, 'w') as f:
            json.dump(phones, f)

        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            alloc.release_dongle('AA:BB:CC:DD:EE:01')

            with open(path) as f:
                result = json.load(f)
            assert result[0]['adapter_mac'] is None
            assert result[0]['phone_bt_mac'] is None

    def test_case_insensitive_match(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        phones = [{
            'adb_serial': 'SER001',
            'adapter_mac': 'aa:bb:cc:dd:ee:01',
        }]
        with open(path, 'w') as f:
            json.dump(phones, f)

        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            alloc.release_dongle('AA:BB:CC:DD:EE:01')

            with open(path) as f:
                result = json.load(f)
            assert result[0]['adapter_mac'] is None

    def test_no_match_is_noop(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        phones = [{'adb_serial': 'SER001', 'adapter_mac': 'FF:FF:FF:FF:FF:FF'}]
        with open(path, 'w') as f:
            json.dump(phones, f)

        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            alloc.release_dongle('AA:BB:CC:DD:EE:01')
            # Should not crash, file unchanged
            with open(path) as f:
                result = json.load(f)
            assert result[0]['adapter_mac'] == 'FF:FF:FF:FF:FF:FF'


class TestClaimSpareDongle:
    def test_claims_unassigned_dongle(self, tmp_path):
        """SER001's old dongle (01) is gone. SER002 has 02. Spare 03 is live."""
        path = str(tmp_path / 'phones.json')
        phones = [
            {'adb_serial': 'SER001', 'adapter_mac': 'AA:BB:CC:DD:EE:01'},  # dead
            {'adb_serial': 'SER002', 'adapter_mac': 'AA:BB:CC:DD:EE:02'},
        ]
        with open(path, 'w') as f:
            json.dump(phones, f)

        # Only 02 and 03 are live — 01 is physically gone
        fake_enum = lambda: {
            'AA:BB:CC:DD:EE:02': 'hci1',
            'AA:BB:CC:DD:EE:03': 'hci2',  # spare, not assigned
        }

        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            result = alloc.claim_spare_dongle('SER001', _enum_dongles=fake_enum)
            assert result == 'AA:BB:CC:DD:EE:03'

    def test_returns_none_when_all_assigned(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        phones = [
            {'adb_serial': 'SER001', 'adapter_mac': 'AA:BB:CC:DD:EE:01'},
            {'adb_serial': 'SER002', 'adapter_mac': 'AA:BB:CC:DD:EE:02'},
        ]
        with open(path, 'w') as f:
            json.dump(phones, f)

        fake_enum = lambda: {
            'AA:BB:CC:DD:EE:01': 'hci0',
            'AA:BB:CC:DD:EE:02': 'hci1',
        }

        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            result = alloc.claim_spare_dongle('SER003', _enum_dongles=fake_enum)
            assert result is None

    def test_excludes_requesting_phone(self, tmp_path):
        """The requesting phone's own assignment should not block it."""
        path = str(tmp_path / 'phones.json')
        phones = [
            {'adb_serial': 'SER001', 'adapter_mac': 'AA:BB:CC:DD:EE:01'},
        ]
        with open(path, 'w') as f:
            json.dump(phones, f)

        fake_enum = lambda: {
            'AA:BB:CC:DD:EE:01': 'hci0',
        }

        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            # SER001 asking — its own MAC should not count as "assigned"
            result = alloc.claim_spare_dongle('SER001', _enum_dongles=fake_enum)
            assert result == 'AA:BB:CC:DD:EE:01'
