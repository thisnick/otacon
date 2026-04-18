"""Smoke tests for pure parser functions."""

import unittest
from dataclasses import asdict

from fleet_agent.steps.screen import parse_stream_max
from fleet_agent.bluetooth.dongle import parse_hciconfig
from fleet_agent.bluetooth.pair import find_pair_button_in_tree
from fleet_agent.phone.status import MonitorStatus, StepStatus, HealStatus


class TestParseStreamMax(unittest.TestCase):
    DUMPSYS = """\
- STREAM_VOICE_CALL:
   Mute count: 0
   Max: 5
   Headset: 4
- STREAM_MUSIC:
   Mute count: 0
   Max: 15
   Headset: 10
"""

    def test_music_max(self):
        self.assertEqual(parse_stream_max(self.DUMPSYS, '3'), 15)

    def test_voice_max(self):
        self.assertEqual(parse_stream_max(self.DUMPSYS, '0'), 5)

    def test_unknown_stream(self):
        self.assertIsNone(parse_stream_max(self.DUMPSYS, '99'))

    def test_empty_output(self):
        self.assertIsNone(parse_stream_max('', '3'))


class TestParseHciconfig(unittest.TestCase):
    OUTPUT = """\
hci1:	Type: Primary  Bus: USB
	BD Address: AA:BB:CC:DD:EE:01  ACL MTU: 310:10  SCO MTU: 64:8
	UP RUNNING PSCAN ISCAN

hci0:	Type: Primary  Bus: USB
	BD Address: AA:BB:CC:DD:EE:00  ACL MTU: 1021:8  SCO MTU: 64:1
	UP RUNNING
"""

    def test_parses_two_adapters(self):
        result = parse_hciconfig(self.OUTPUT)
        self.assertEqual(len(result), 2)
        self.assertEqual(result['AA:BB:CC:DD:EE:01'], 'hci1')
        self.assertEqual(result['AA:BB:CC:DD:EE:00'], 'hci0')

    def test_empty_output(self):
        self.assertEqual(parse_hciconfig(''), {})

    def test_skips_zero_mac(self):
        out = "hci0:\tType: Primary\n\tBD Address: 00:00:00:00:00:00  ACL MTU: 1\n"
        self.assertEqual(parse_hciconfig(out), {})


class TestFindPairButton(unittest.TestCase):
    def test_finds_pair_button(self):
        tree = {
            'text': 'root',
            'clickable': False,
            'children': [
                {'text': 'Cancel', 'clickable': True, 'ref_id': 'cancel-1'},
                {'text': 'Pair', 'clickable': True, 'ref_id': 'pair-1'},
            ],
        }
        self.assertEqual(find_pair_button_in_tree(tree), 'pair-1')

    def test_finds_allow_button(self):
        tree = {'text': 'Allow', 'clickable': True, 'ref_id': 'allow-1'}
        self.assertEqual(find_pair_button_in_tree(tree), 'allow-1')

    def test_ignores_non_clickable(self):
        tree = {'text': 'Pair', 'clickable': False, 'ref_id': 'pair-1'}
        self.assertIsNone(find_pair_button_in_tree(tree))

    def test_none_data(self):
        self.assertIsNone(find_pair_button_in_tree(None))

    def test_list_input(self):
        tree = [
            {'text': 'other', 'clickable': True, 'ref_id': 'x'},
            {'text': 'Pair', 'clickable': True, 'ref_id': 'pair-2'},
        ]
        self.assertEqual(find_pair_button_in_tree(tree), 'pair-2')


class TestMonitorStatusSchema(unittest.TestCase):
    """Validate the JSON schema shape that tests/evaluator will assert against."""

    def test_default_serializes(self):
        status = MonitorStatus()
        d = asdict(status)
        self.assertEqual(d['phase'], 'setup')
        self.assertEqual(d['setup'], {})
        self.assertEqual(d['health'], {})
        self.assertEqual(d['heals'], {})
        self.assertEqual(d['loop_iteration'], 0)
        self.assertIsNone(d['last_check_at'])

    def test_populated_serializes(self):
        status = MonitorStatus(phase='monitoring', loop_iteration=3)
        status.setup['screen'] = StepStatus(
            attempted=True, succeeded=True,
            attempted_at='2026-01-01T00:00:00+00:00',
            succeeded_at='2026-01-01T00:00:01+00:00',
        )
        status.health['bt_connected'] = True
        status.heals['bt_connected'] = HealStatus(
            last_at='2026-01-01T00:01:00+00:00',
            last_result='ok',
            count_today=1,
        )
        d = asdict(status)
        self.assertTrue(d['setup']['screen']['attempted'])
        self.assertTrue(d['setup']['screen']['succeeded'])
        self.assertTrue(d['health']['bt_connected'])
        self.assertEqual(d['heals']['bt_connected']['count_today'], 1)
        self.assertEqual(d['heals']['bt_connected']['last_result'], 'ok')


if __name__ == '__main__':
    unittest.main()
