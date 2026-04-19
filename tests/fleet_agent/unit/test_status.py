"""Unit tests for phone/status.py — pure dataclass logic, no I/O."""

from dataclasses import asdict

from fleet_agent.phone.status import (
    MonitorStatus, StepStatus, HealStatus, now_iso,
)


class TestStepStatus:
    def test_defaults(self):
        s = StepStatus()
        assert s.attempted is False
        assert s.succeeded is False
        assert s.attempted_at is None
        assert s.succeeded_at is None
        assert s.error is None

    def test_marks_attempted(self):
        s = StepStatus(attempted=True, attempted_at='2026-01-01T00:00:00+00:00')
        assert s.attempted is True
        assert s.attempted_at is not None

    def test_serializes_to_dict(self):
        s = StepStatus(attempted=True, succeeded=True, error=None)
        d = asdict(s)
        assert isinstance(d, dict)
        assert d['attempted'] is True
        assert d['succeeded'] is True


class TestHealStatus:
    def test_defaults(self):
        h = HealStatus()
        assert h.last_at is None
        assert h.last_result is None
        assert h.count_today == 0
        assert h.last_error is None

    def test_tracks_heal(self):
        h = HealStatus(
            last_at='2026-01-01T00:00:00+00:00',
            last_result='ok',
            count_today=3,
        )
        assert h.count_today == 3
        assert h.last_result == 'ok'


class TestMonitorStatus:
    def test_defaults(self):
        m = MonitorStatus()
        assert m.phase == 'setup'
        assert m.setup == {}
        assert m.health == {}
        assert m.heals == {}
        assert m.loop_iteration == 0
        assert m.last_check_at is None

    def test_phase_transitions(self):
        m = MonitorStatus()
        assert m.phase == 'setup'
        m.phase = 'monitoring'
        assert m.phase == 'monitoring'
        m.phase = 'stopped'
        assert m.phase == 'stopped'

    def test_setup_steps_tracked(self):
        m = MonitorStatus()
        m.setup['configure_screen'] = StepStatus(attempted=True, succeeded=True)
        m.setup['connect_wifi'] = StepStatus(attempted=True, succeeded=False, error='timeout')
        assert m.setup['configure_screen'].succeeded is True
        assert m.setup['connect_wifi'].error == 'timeout'

    def test_health_checks_tracked(self):
        m = MonitorStatus()
        m.health['bt_bonded'] = True
        m.health['bt_connected'] = False
        m.health['wifi'] = True
        assert m.health['bt_bonded'] is True
        assert m.health['bt_connected'] is False

    def test_heals_tracked(self):
        m = MonitorStatus()
        m.heals['bt_bonded'] = HealStatus(
            last_at=now_iso(), last_result='ok', count_today=1)
        assert m.heals['bt_bonded'].count_today == 1

    def test_loop_iteration_increments(self):
        m = MonitorStatus()
        m.loop_iteration += 1
        m.last_check_at = now_iso()
        assert m.loop_iteration == 1
        assert m.last_check_at is not None

    def test_serializes_fully(self):
        m = MonitorStatus()
        m.setup['screen'] = StepStatus(attempted=True, succeeded=True)
        m.health['wifi'] = True
        m.heals['wifi'] = HealStatus(count_today=2)
        d = asdict(m)
        assert d['phase'] == 'setup'
        assert d['setup']['screen']['succeeded'] is True
        assert d['health']['wifi'] is True
        assert d['heals']['wifi']['count_today'] == 2


class TestNowIso:
    def test_returns_iso_string(self):
        ts = now_iso()
        assert isinstance(ts, str)
        assert 'T' in ts
        # Should contain timezone info
        assert '+' in ts or 'Z' in ts
