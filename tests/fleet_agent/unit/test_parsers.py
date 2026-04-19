"""Unit tests for pure parser functions — no I/O, no mocking needed."""

from fleet_agent.steps.screen import parse_stream_max
from fleet_agent.bluetooth.dongle import parse_hciconfig
from fleet_agent.bluetooth.pair import find_pair_button_in_tree


class TestParseStreamMax:
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

    def test_music_stream(self):
        assert parse_stream_max(self.DUMPSYS, '3') == 15

    def test_voice_stream(self):
        assert parse_stream_max(self.DUMPSYS, '0') == 5

    def test_unknown_stream(self):
        assert parse_stream_max(self.DUMPSYS, '99') is None

    def test_empty_output(self):
        assert parse_stream_max('', '3') is None

    def test_malformed_max_line(self):
        bad = "- STREAM_MUSIC:\n   Max: not-a-number\n"
        assert parse_stream_max(bad, '3') is None

    def test_missing_max_line(self):
        no_max = "- STREAM_MUSIC:\n   Mute count: 0\n   Headset: 10\n"
        assert parse_stream_max(no_max, '3') is None


class TestParseHciconfig:
    def test_two_adapters(self):
        output = (
            "hci1:\tType: Primary  Bus: USB\n"
            "\tBD Address: AA:BB:CC:DD:EE:01  ACL MTU: 310:10  SCO MTU: 64:8\n"
            "\tUP RUNNING PSCAN ISCAN\n"
            "\n"
            "hci0:\tType: Primary  Bus: USB\n"
            "\tBD Address: AA:BB:CC:DD:EE:00  ACL MTU: 1021:8  SCO MTU: 64:1\n"
            "\tUP RUNNING\n"
        )
        result = parse_hciconfig(output)
        assert len(result) == 2
        assert result['AA:BB:CC:DD:EE:01'] == 'hci1'
        assert result['AA:BB:CC:DD:EE:00'] == 'hci0'

    def test_empty(self):
        assert parse_hciconfig('') == {}

    def test_skips_zero_mac(self):
        output = "hci0:\tType: Primary\n\tBD Address: 00:00:00:00:00:00  ACL MTU: 1\n"
        assert parse_hciconfig(output) == {}

    def test_single_adapter(self):
        output = "hci0:\tType: Primary\n\tBD Address: FF:EE:DD:CC:BB:AA  ACL\n"
        result = parse_hciconfig(output)
        assert result == {'FF:EE:DD:CC:BB:AA': 'hci0'}

    def test_lowercases_to_upper(self):
        output = "hci0:\tType: Primary\n\tBD Address: aa:bb:cc:dd:ee:ff  ACL\n"
        result = parse_hciconfig(output)
        assert 'AA:BB:CC:DD:EE:FF' in result


class TestFindPairButtonInTree:
    def test_finds_pair(self):
        tree = {
            'text': 'root', 'clickable': False,
            'children': [
                {'text': 'Cancel', 'clickable': True, 'ref_id': 'cancel-1'},
                {'text': 'Pair', 'clickable': True, 'ref_id': 'pair-1'},
            ],
        }
        assert find_pair_button_in_tree(tree) == 'pair-1'

    def test_finds_allow(self):
        tree = {'text': 'Allow', 'clickable': True, 'ref_id': 'allow-1'}
        assert find_pair_button_in_tree(tree) == 'allow-1'

    def test_ignores_non_clickable(self):
        tree = {'text': 'Pair', 'clickable': False, 'ref_id': 'pair-1'}
        assert find_pair_button_in_tree(tree) is None

    def test_none_input(self):
        assert find_pair_button_in_tree(None) is None

    def test_list_input(self):
        tree = [
            {'text': 'other', 'clickable': True, 'ref_id': 'x'},
            {'text': 'Pair', 'clickable': True, 'ref_id': 'pair-2'},
        ]
        assert find_pair_button_in_tree(tree) == 'pair-2'

    def test_case_insensitive(self):
        tree = {'text': 'PAIR', 'clickable': True, 'ref_id': 'pair-3'}
        assert find_pair_button_in_tree(tree) == 'pair-3'

    def test_nested_tree(self):
        tree = {
            'text': '', 'clickable': False,
            'children': [{
                'text': '', 'clickable': False,
                'children': [
                    {'text': 'Pair', 'clickable': True, 'ref_id': 'deep-pair'},
                ],
            }],
        }
        assert find_pair_button_in_tree(tree) == 'deep-pair'

    def test_empty_tree(self):
        tree = {'text': '', 'clickable': False}
        assert find_pair_button_in_tree(tree) is None
