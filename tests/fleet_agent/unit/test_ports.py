"""Unit tests for util/ports.py — PortAllocator logic."""

import json
import os
from unittest.mock import patch

from fleet_agent.util.ports import PortAllocator


class TestPortAllocator:
    def test_allocates_first_index(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator(snapshot_start=9091, internal_start=8081,
                                  display_start=50, vnc_start=5900)
            sp, ip, dn, vp = alloc.allocate('SERIAL_A')
            assert sp == 9091
            assert ip == 8081
            assert dn == 50
            assert vp == 5900

    def test_second_serial_gets_next_index(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            alloc.allocate('SERIAL_A')
            sp, ip, dn, vp = alloc.allocate('SERIAL_B')
            assert sp == 9092
            assert ip == 8082

    def test_same_serial_reuses_ports(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            first = alloc.allocate('SERIAL_A')
            second = alloc.allocate('SERIAL_A')
            assert first == second

    def test_persists_to_json(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            alloc.allocate('SERIAL_A')
            with open(path) as f:
                phones = json.load(f)
            assert len(phones) == 1
            assert phones[0]['adb_serial'] == 'SERIAL_A'
            assert phones[0]['snapshot_port'] == 9091

    def test_loads_from_existing_json(self, tmp_path):
        path = str(tmp_path / 'phones.json')
        phones = [{'adb_serial': 'SERIAL_A', 'snapshot_port': 9091,
                    'internal_port': 8081, 'display_num': 50, 'vnc_port': 5900}]
        with open(path, 'w') as f:
            json.dump(phones, f)
        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            sp, ip, dn, vp = alloc.allocate('SERIAL_A')
            assert sp == 9091

    def test_fills_gaps(self, tmp_path):
        """If idx 0 and 2 are taken, idx 1 should be assigned next."""
        path = str(tmp_path / 'phones.json')
        phones = [
            {'adb_serial': 'A', 'snapshot_port': 9091, 'internal_port': 8081,
             'display_num': 50, 'vnc_port': 5900},
            {'adb_serial': 'C', 'snapshot_port': 9093, 'internal_port': 8083,
             'display_num': 52, 'vnc_port': 5902},
        ]
        with open(path, 'w') as f:
            json.dump(phones, f)
        with patch('fleet_agent.util.ports.PHONES_JSON_PATH', path):
            alloc = PortAllocator()
            sp, ip, dn, vp = alloc.allocate('B')
            assert sp == 9092  # fills the gap at idx 1
