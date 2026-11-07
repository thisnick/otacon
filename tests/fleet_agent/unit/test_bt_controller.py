"""Unit tests for resetting a wedged Bluetooth controller (otacon-pi, 2026-11).

A dongle whose controller had stopped making connections failed every pair
until someone ran `hciconfig hciN reset` by hand: l2ping from it said
"Operation already in progress" with no connection on the adapter.
"""

from unittest.mock import MagicMock, patch

import pytest

import fleet_agent.bluetooth.controller as ctl

ADAPTER = 'F4:4E:FC:59:A6:09'
HCI = 'hci2'
PHONE_BT = '4C:2E:5E:D2:D6:00'

WEDGED = MagicMock(returncode=1, stdout='', stderr="Can't connect: Operation already in progress\n")
HOST_DOWN = MagicMock(returncode=1, stdout='', stderr="Can't connect: Host is down\n")
PONG = MagicMock(returncode=0, stdout='44 bytes from 4C:2E:5E:D2:D6:00 id 0 time 36.04ms\n', stderr='')
NO_CONN = MagicMock(returncode=0, stdout='Connections:\n', stderr='')
CONN = MagicMock(returncode=0, stdout=f'Connections:\n\t< ACL {PHONE_BT} handle 12 state 1 lm CENTRAL\n',
                 stderr='')
RESET_OK = MagicMock(returncode=0, stdout='', stderr='')


class FakeHost:
    """Answers run_cmd like the Pi: l2ping, hcitool con, hciconfig reset."""

    def __init__(self, l2ping=WEDGED, con=NO_CONN, reset=RESET_OK):
        # l2ping: one answer for every probe, or a list answered in order
        self.l2ping = l2ping if isinstance(l2ping, list) else [l2ping]
        self.con, self.reset = con, reset
        self.calls = []

    def __call__(self, args, input=None, timeout=10):
        self.calls.append(args)
        if args[0] == 'l2ping':
            return self.l2ping.pop(0) if len(self.l2ping) > 1 else self.l2ping[0]
        if args[0] == 'hcitool':
            return self.con
        if args[:3] == ['hciconfig', HCI, 'reset']:
            return self.reset
        raise AssertionError(f'unexpected command {args}')

    @property
    def resets(self):
        return [c for c in self.calls if c[:1] == ['hciconfig']]


@pytest.fixture(autouse=True)
def clean_state():
    ctl._failures.clear()
    ctl._last_reset.clear()
    with patch.object(ctl.time, 'sleep'):
        yield
    ctl._failures.clear()
    ctl._last_reset.clear()


def run(host, **kw):
    with patch.object(ctl, 'run_cmd', side_effect=host):
        return ctl.recover_if_wedged(ADAPTER, HCI, PHONE_BT, 'SER', **kw)


class TestIsWedged:
    @pytest.mark.parametrize('l2ping,con,wedged', [
        (WEDGED, NO_CONN, True),
        (WEDGED, CONN, False),       # a connection is being made; not stuck
        (HOST_DOWN, NO_CONN, False),  # phone unreachable, controller fine
        (PONG, NO_CONN, False),
    ])
    def test_signature(self, l2ping, con, wedged):
        host = FakeHost(l2ping=l2ping, con=con)
        with patch.object(ctl, 'run_cmd', side_effect=host):
            assert ctl.is_wedged(HCI, PHONE_BT) is wedged

    def test_needs_two_probes(self):
        host = FakeHost(l2ping=[WEDGED, PONG])
        with patch.object(ctl, 'run_cmd', side_effect=host):
            assert ctl.is_wedged(HCI, PHONE_BT) is False

    def test_probe_uses_the_assigned_adapter(self):
        host = FakeHost()
        with patch.object(ctl, 'run_cmd', side_effect=host):
            ctl.is_wedged(HCI, PHONE_BT)
        assert host.calls[0] == ['l2ping', '-i', HCI, '-c', '1', '-t', '3', PHONE_BT]
        assert host.calls[-1] == ['hcitool', '-i', HCI, 'con']


class TestRecoverIfWedged:
    def test_wedged_adapter_is_reset_and_reported(self):
        host = FakeHost()
        report = MagicMock()

        assert run(host, report_error=report) is True

        assert host.resets == [['hciconfig', HCI, 'reset']]
        category, message, data = report.call_args[0]
        assert category == 'bluetooth.adapter_reset'
        assert HCI in message and 'pair' in message
        assert data['reset_ok'] is True

    def test_healthy_adapter_is_left_alone(self):
        host = FakeHost(l2ping=HOST_DOWN)
        report = MagicMock()

        assert run(host, report_error=report) is False

        assert host.resets == []
        report.assert_not_called()

    def test_resets_without_signature_after_repeated_failures(self):
        host = FakeHost(l2ping=HOST_DOWN)
        results = [run(host) for _ in range(ctl.RESET_AFTER_FAILURES)]

        assert results == [False] * (ctl.RESET_AFTER_FAILURES - 1) + [True]
        assert len(host.resets) == 1

    def test_success_clears_the_failure_count(self):
        host = FakeHost(l2ping=HOST_DOWN)
        for _ in range(ctl.RESET_AFTER_FAILURES - 1):
            run(host)
        ctl.note_link_ok(ADAPTER.lower())

        assert run(host) is False
        assert host.resets == []

    def test_cooldown_between_resets(self):
        host = FakeHost()
        now = [1000.0]
        with patch.object(ctl.time, 'monotonic', side_effect=lambda: now[0]):
            assert run(host) is True
            now[0] += ctl.RESET_COOLDOWN_SECONDS - 1
            assert run(host) is False
            now[0] += 2
            assert run(host) is True
        assert len(host.resets) == 2

    def test_failed_reset_is_reported_and_still_cools_down(self):
        host = FakeHost(reset=MagicMock(returncode=1, stdout='', stderr='Connection timed out'))
        report = MagicMock()

        assert run(host, report_error=report) is False
        assert report.call_args[0][2]['reset_ok'] is False
        assert run(host) is False
        assert len(host.resets) == 1

    def test_no_adapter_does_nothing(self):
        host = FakeHost()
        with patch.object(ctl, 'run_cmd', side_effect=host):
            assert ctl.recover_if_wedged(ADAPTER, None, PHONE_BT, 'SER') is False
        assert host.calls == []


class TestPairFlowHook:
    @pytest.fixture
    def pair_env(self, monkeypatch):
        monkeypatch.setenv('AUDIO_BACKEND', 'bluetooth')
        answer = {'pair': 'Row: 0 error=pairing timed out or failed'}

        def fake_adb_shell(serial, cmd, timeout=10):
            if 'bluetooth_address' in cmd:
                return PHONE_BT + '\n'
            if 'bluetooth/pair' in cmd:
                return answer['pair']
            if 'bluetooth/unpair' in cmd:
                return 'Row: 0 ok=true'
            return ''

        p = 'fleet_agent.bluetooth.pair.'
        from fleet_agent.phone.health import BtBondedDetail
        patches = [
            patch(p + 'allocate_dongle', return_value=(ADAPTER, HCI, None)),
            patch(p + 'enum_dongles', return_value={ADAPTER: HCI}),
            patch(p + 'adb_shell', side_effect=fake_adb_shell),
            patch(p + 'ensure_screen_on'),
            patch(p + '_run_bluez_pair', side_effect=lambda mac, hci, serial, ready: ready.set()),
            patch(p + '_do_pair_tap_loop'),
            patch(p + 'apply_restrictions'),
            patch(p + 'run_cmd', return_value=MagicMock(stdout='Paired: no')),
            patch(p + 'save_dongle_assignment'),
            patch(p + 'time.sleep'),
            patch('fleet_agent.phone.health.check_bt_bonded',
                  return_value=BtBondedDetail(pi=False, phone=False)),
        ]
        for pt in patches:
            pt.start()
        recover = patch(p + 'recover_if_wedged').start()
        ok = patch(p + 'note_link_ok').start()
        yield answer, recover, ok
        patch.stopall()

    def test_failed_pair_checks_the_controller(self, pair_env):
        from fleet_agent.bluetooth.pair import allocate_and_pair_bluetooth
        _answer, recover, ok = pair_env
        report = MagicMock()

        allocate_and_pair_bluetooth('SER', 'http://snap', report_error=report)

        recover.assert_called_once_with(ADAPTER, HCI, PHONE_BT, 'SER', report_error=report)
        ok.assert_not_called()

    def test_successful_pair_clears_failures(self, pair_env):
        from fleet_agent.bluetooth.pair import allocate_and_pair_bluetooth
        answer, recover, ok = pair_env
        answer['pair'] = 'Row: 0 ok=true, status=paired'

        allocate_and_pair_bluetooth('SER', 'http://snap')

        ok.assert_called_once_with(ADAPTER)
        recover.assert_not_called()


class TestReconnectHealHook:
    def test_failed_reconnect_checks_the_controller(self, phone_agent):
        with patch('fleet_agent.phone.agent.heal.heal_bt_connected', return_value=False), \
             patch('fleet_agent.phone.agent.recover_if_wedged') as recover:
            phone_agent._run_heal('bt_connected')

        recover.assert_called_once_with(
            phone_agent.adapter_mac, phone_agent.adapter_hci, phone_agent.phone_bt_mac,
            phone_agent.serial, report_error=phone_agent._report_error, after='reconnect')

    def test_reconnect_success_clears_failures(self, phone_agent):
        with patch('fleet_agent.phone.agent.heal.heal_bt_connected', return_value=True), \
             patch('fleet_agent.phone.agent.recover_if_wedged') as recover, \
             patch('fleet_agent.phone.agent.note_link_ok') as ok:
            phone_agent._run_heal('bt_connected')

        ok.assert_called_once_with(phone_agent.adapter_mac)
        recover.assert_not_called()
